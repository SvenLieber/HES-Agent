const schemas = require("../config").schemas;
const fu = require("./persistence");
const _ = require('lodash');
const validUrl = require('valid-url');
const path = require('path');
const Ajv = require('ajv');
const Glob = require("glob").Glob

// https://github.com/jriecken/dependency-graph
const DepGraph = require('dependency-graph').DepGraph;
const minimatch = require("minimatch");

function toJson(x) {
    return JSON.stringify(x, null, 2);
}

let ajv = new Ajv(); // options can be passed, e.g. {allErrors: true}
let metaOperationSchema = fu.readJson(schemas.metaOperationSchema);
let validateOperation = ajv.compile(metaOperationSchema);

class DSL_V1 {

    constructor(context) {
        if (!context) {
            throw new Error('Need context');
        }
        if (!context.serverOptions) {
            throw new Error('Need server options');
        }
        if (!context.serverOptions.workSpacePath) {
            throw new Error('Need workSpacePath');
        }
        this.context = context;
        this.serverOptions = context.serverOptions;
    }

    /**
     * Schema
     */
    static validateOperation(meta) {
        return validateOperation(meta);
    }

    getAllKnownOperations(dirRelativeTo){
        let graph = this.buildLocalDependencyGraph(dirRelativeTo);
        return graph.overallOrder();
    }

    toRelativePath(someDirectory){
        return someDirectory.replaceAll(this.serverOptions.workSpacePath,'');
    }

    /**
     * Experimental, dependency graph
     */
    buildLocalDependencyGraph(dirRelativeTo){
        // Measuring how long it takes
        let start = new Date();

        let graph = new DepGraph();

        // All files
        let pattern = "**/"+this.serverOptions.indexFile;
        let indexes = new Glob(pattern, {mark: true, sync:true, absolute:true, nodir:true, cwd:dirRelativeTo}).found;

        // First run to add nodes
        for (let currentDir of indexes){
            let index = fu.readJson(currentDir);
            if (index.features){
                for (let featureName in index.features) {
                    let meta = index.features[featureName];
                    // Take out the index.json part
                    let parent = currentDir.substr(0, currentDir.lastIndexOf('/'));
                    // Make the path relative and add operation name
                    let id = this.toRelativePath(parent) + '/' + featureName;
                    graph.addNode(id,meta);
                }
            }
        }
        // The graph will be used to expand meta
        this.dependencyGraph = graph;

        //Second run to expand meta and add dependencies
        this.allNodes = this.dependencyGraph.overallOrder();

        for (let id of this.allNodes){
            let meta = graph.getNodeData(id);
            // Take out the operation name
            let parent = id.substr(0, id.lastIndexOf('/'));
            let dirRelativeTo = path.join(this.serverOptions.workSpacePath,parent);
            try {
                let expanded = this.expandMeta(dirRelativeTo, meta);
                graph.setNodeData(id,expanded);
            } catch (e) {
                let error = {
                    message:"ERROR: cannot expand operation",
                    operation:id,
                    meta:meta,
                    source:e.message
                };
                if (e.message==="Maximum call stack size exceeded"){
                    throw e;// Fatal for circular dependencies
                }
                console.error(JSON.stringify(error,null,2));
            }

            this.addDependencies(graph,id,meta)
        }

        let end = new Date() - start;
        console.log('built dependency graph '+end+' ms');

        return graph;
    }

    addDependencies(graph,id,meta){
        if (meta.query || meta.raw) {
            // No dependencies
        } else if (typeof meta === 'string') {
            this.addDependency(graph,id,meta);
        } else if (meta.handlebars) {
            if (meta.context) {
                for (let param in meta.context){
                    for (let current of ensureArray(meta.context[param])){
                        this.addDependency(graph,id,current);

                    }
                }
            }
        } else if (meta.inference) {
            let inference = meta.inference;
            if (!inference.query){
                throw Error ('No query defined in '+JSON.stringify(meta,null,2));
            }
            // Query dependencies
            if (inference.query) {
                this.addDependency(graph,id,inference.query);
            }
            if (!inference.data){
                throw Error ('No data defined in '+JSON.stringify(meta,null,2));
            }
            // Data dependencies
            if (inference.data){
                for (let current of ensureArray(inference.data)){
                    this.addDependency(graph,id,current);
                }
            }
        }
    }

    addDependency(graph, from, to){
        // A web resource
        if (validUrl.is_web_uri(to)){
            // Which is currently being exposed
            if (this.context.isLocalApiPath(to)){
                // And and a defined operation
                let targetContext = this.context.getContextForURL(to);
                let targetOperation = targetContext.getLocalHref();
                if (graph.hasNode(targetOperation)) { // which could be a defined operation
                    graph.addDependency(from, targetOperation);
                }
            }

        } else { // A local resource
            let targetOperation = this.toRelativePath(to);
            if (graph.hasNode(targetOperation)){ // which could be a defined operation
                graph.addDependency(from, targetOperation);
            }
        }
    }

    /**
     * First layer
     *
     * Expand relative files
     * Expand directories
     * Expand operations
     */

    expandMeta(dirRelativeTo, meta) {
        if (!this.dependencyGraph) {
            throw new Error('Need to build dependencies');
        }
        if (meta['raw']) {
            return meta;
        } else if (meta.query) {
            return this.expandQuery(dirRelativeTo, meta);
        } else if (meta.inference) {
            return this.expandInference(dirRelativeTo, meta);
        } else if (meta.use) {
            return this.expandExternal(dirRelativeTo, meta);
        } else if (meta.handlebars) {
            return this.expandHandlebars(dirRelativeTo, meta);
        } else if (typeof meta === 'string'){
            return this.expandHref(dirRelativeTo, meta);
        }
        throw Error("I don't know how to interpret:" + toJson(meta));
    }

    expandHref(dirRelativeTo, meta) {
        return this.toDereferenciable(dirRelativeTo, meta);
    }

    expandQuery(dirRelativeTo, meta) {
        let query = meta.query;
        if (query.sparql) {
            query.sparql = this.toDereferenciable(dirRelativeTo, query.sparql);
        }
        meta.query = query;
        return meta;
    }

    expandInference(dirRelativeTo, meta) {
        let inference = meta.inference;
        if (inference.query) {
            inference.query = this.toDereferenciable(dirRelativeTo, inference.query);
        }
        if (inference.data) {
            inference.data = _.flatMap(ensureArray(inference.data), target => {
                return this.toDereferenciables(dirRelativeTo, target);
            });
        }
        meta.inference = inference;
        return meta;
    }

    expandHandlebars(dirRelativeTo, meta) {
        let context = meta.context?meta.context:{};

        if (meta.withUrls){
            for (let param in meta.withUrls) {
                context[param] = this.toDereferenciables(dirRelativeTo,meta.withUrls[param]);
            }
            delete meta.withUrls;
        }

        if (meta.withUrl){
            for (let param in meta.withUrl) {
                context[param] = this.toDereferenciable(dirRelativeTo,meta.withUrl[param]);
            }
            delete meta.withUrl;
        }

        if (meta.handlebars){
            meta.handlebars = this.toDereferenciable(dirRelativeTo,meta.handlebars);
        }

        meta.context = context;
        return meta;
    }

    expandExternal(dirRelativeTo, meta) {

        let targetPath = this.toAbsolutePath(dirRelativeTo, meta.use);
        let targetOperation = this.toRelativePath(targetPath);

        // Check if this is an operation
        if (this.dependencyGraph.hasNode(targetOperation)) {

            // The operation to be imported
            let _operation = this.dependencyGraph.getNodeData(targetOperation);


            if (_operation.inference) {

                // Take out the operation name
                let parent = targetPath.substr(0, targetPath.lastIndexOf('/'));
                // Clone
                let result = JSON.parse(JSON.stringify(this.expandInference(parent,_operation)));

                // Override description if present
                if (meta.description) {
                    result.description = meta.description;
                }
                // Override meta if present
                if (meta['Content-Type']){
                    result['Content-Type'] = meta['Content-Type'];
                }
                /**
                 * It's not clear yet how I will represent Set, Union, Intersection etc.
                 */
                if (meta.query) {
                    result.inference.query = this.toAbsolutePath(dirRelativeTo,context.toResourcePath(meta.query));
                }
                if (meta.options) {
                    result.inference.options = meta.options;
                }
                if (meta.flags) {
                    result.inference.flags = meta.flags;
                }

                // Special cases @TODO enable json paths if does not complicate the DSL (https://lodash.com/docs/4.17.5#get)
                if (meta['without']){
                    let toRemove = _.flatMap(ensureArray(meta['without']['inference.data']), target => {return this.toDereferenciables(dirRelativeTo, target)});
                    result.inference.data = _.difference(result.inference.data,toRemove);
                }
                if (meta['with']){
                    let toAdd = _.flatMap(ensureArray(meta['with']['inference.data']), target => {return this.toDereferenciables(dirRelativeTo, target)});
                    result.inference.data = _.union(result.inference.data,toAdd);
                }

                result.inference.data = _.uniq(result.inference.data);
                return result;
            }

            if (typeof _operation !== 'string'){
                if (meta['Content-Type']){
                    _operation['Content-Type'] = meta['Content-Type'];
                }
            }

            // It was other kind of operation
            return this.expandMeta(targetPath, _operation);
        } else {
            throw new Error('Could not find operation  ' + meta.use + ' in ' + targetPath);
        }
    }


    /**
     * Goes from relative path to absolute path
     * Fails if not in the current workspace
     */
    toAbsolutePath(dirRelativeTo, value) {

        if (typeof value !== 'string') {
            throw Error("I don't know how to handle " + toJson(value));
        }

        // Already expanded
        if (value.startsWith(this.serverOptions.workSpacePath)) {
            return value;
        }

        let result;
        if (path.isAbsolute(value)) {
            result = path.join(this.serverOptions.workSpacePath, value);
        } else {
            result = path.join(dirRelativeTo, value);
        }

        if (!result.startsWith(this.serverOptions.workSpacePath)) {
            throw Error('403 [' + result + ']');
        }

        return result;

    }


    /**
     * Expands an href into a de-referenciable resource (by the reasoner)
     *
     * Valid href values are:
     *
     *  - An external URL, which expands to URL.
     *  - A file (relative), which expands to a absolute file.
     *  - A file (absolute), which expands to a absolute file.
     *  - A call to a meta-operation, which expands to URL.
     */
    toDereferenciable(dirRelativeTo, value) {

        // External URL
        if (validUrl.is_web_uri(value)) { // other uri resources
            return value;
        }

        let targetPath = this.toAbsolutePath(dirRelativeTo, value);
        let targetOperation = this.toRelativePath(targetPath);

        if (this.dependencyGraph.hasNode(targetOperation)){
            return this.context.toApiPath(targetPath);
        }

        if (fu.exists(targetPath)){
            if (fu.isDirectory(targetPath)) {
                return this.context.toApiPath(targetPath);
            }
            return this.context.toResourcePath(targetPath);
        }

        throw Error('404 [' + value + ']');
    }

    /**
     * Expands an href into a list of de-referenciable resources (by the reasoner)
     *
     * Valid href values are:
     *
     *  - An external URL, which expands to [URL].
     *  - A directory (relative), fails
     *  - A directory (absolute), fails
     *  - A glob file pattern (relative), which expands to a [file].
     *  - A glob file pattern (absolute), which expands to a [file].
     *  - A call to a meta-operation, which expands to [URL].
     */
    toDereferenciables(dirRelativeTo, value) {

        //console.log('expanding many',dirRelativeTo,value);
        // External URL
        if (validUrl.is_web_uri(value)) { // other uri resources
            return [value]
        }

        let results = [];

        // Search for files.
        let glob;
        if (path.isAbsolute(value)) {
            // options for absolute
            let options = {mark: true, sync:true, root:this.serverOptions.workSpacePath, ignore:'**/'+this.serverOptions.indexFile, absolute:false, nodir:true};
            glob = new Glob(this.toRelativePath(value), options);
        } else {
            // options for relative
            let options = {mark: true, sync:true, cwd:dirRelativeTo, ignore:'**/'+this.serverOptions.indexFile, absolute:true, nodir:true};
            glob = new Glob(value, options);
        }
        if (glob.found && glob.found.length > 0){
            results = glob.found.map(x => this.context.toResourcePath(x));
        }

        // Search for operations
        let targetPath = this.toAbsolutePath(dirRelativeTo, value);
        let targetOperation = this.toRelativePath(targetPath);
        let matches = minimatch.match(this.allNodes, targetOperation);

        for (let current of matches){
            let operationLocalPath = path.join(this.context.serverOptions.workSpacePath,current);
            results.push(this.context.toApiPath( operationLocalPath ))
        }

        if (results.length > 0) {
            //console.log('found:',results.length);
            return results;
        }

        if (!fu.exists(targetPath)){
            throw Error('404 [' + value +']');
        }

        if (fu.isDirectory(targetPath)){
            throw Error('400 [' + this.context.toApiPath(targetPath) + '] is not a valid resource');
        }

        throw Error('500 [' + value + ' unhandled error ]');
    }

}

function ensureArray(value){
    if (typeof value === 'string'){
        return [value];
    } else {
        return value;
    }
}

module.exports = DSL_V1;
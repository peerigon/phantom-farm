"use strict";

var EventEmitter = require("events").EventEmitter;
var os = require("os");
var ws = require("ws");
var http = require("http");
var util = require("util");
var instances = require("./instances.js");
var Page = require("./Page.js");
var serializeFn = require("./serializeFn.js");
var phantomMethods = require("./phantom/methods.js");

var pageId = 0;
var slice = Array.prototype.slice;
var pingInterval = 100;
var nextRequestId = 0;

/**
 * Provides methods to run code within a given PhantomJS child-process.
 *
 * @constructor
 * @param {ChildProcess} childProcess
 */
function Phantom(childProcess) {
    Phantom.prototype.constructor.apply(this, arguments);
}

Phantom.prototype = Object.create(EventEmitter.prototype);

/**
 * The ChildProcess-instance returned by node.
 *
 * @type {child_process.ChildProcess}
 */
Phantom.prototype.childProcess = null;

/**
 * An object providing the the onCallback function for the phantom himself
 *
 * @type {Function}
 */
Phantom.prototype.onCallback = null;

/**
 * Boolean flag which indicates that this process is about to exit or has already exited.
 *
 * @type {boolean}
 * @private
 */
Phantom.prototype._isDisposed = false;

/**
 * The current scheduled ping id as returned by setTimeout()
 *
 * @type {*}
 * @private
 */
Phantom.prototype._pingTimeoutId = null;

/**
 * The number of currently pending requests. This is necessary so we can stop the interval
 * when no requests are pending.
 *
 * @type {number}
 * @private
 */
Phantom.prototype._pending = 0;

/**
 * An object providing the resolve- and reject-function of all pending requests. Thus we can
 * resolve or reject a pending promise in a different scope.
 *
 * @type {Object}
 * @private
 */
Phantom.prototype._pendingDeferreds = null;

/**
 * An object providing the the onCallback functions for the pages
 *
 * @type {Object}
 * @private
 */
Phantom.prototype._onCallbacks = null;

/**
 * A reference to the unexpected error which caused PhantomJS to exit.
 * Will be appended to the error message for pending deferreds.
 *
 * @type {Error}
 * @private
 */
Phantom.prototype._unexpectedError = null;

/**
 * A reference to the primus server.
 *
 * @type {WebSocketServer}
 * @private
 */
Phantom.prototype._wss = null;

/**
 * A reference to the spark object of the current connection.
 *
 * @type {WebSocketServer.spark}
 * @private
 */
Phantom.prototype._spark = null;

/**
 * Initializes a new Phantom instance.
 *
 * @param {child_process.ChildProcess} childProcess
 */
Phantom.prototype.constructor = function (childProcess) {
    EventEmitter.call(this);

    this._receive = this._receive.bind(this);
    this._write = this._write.bind(this);
    this._afterExit = this._afterExit.bind(this);
    this._onUnexpectedError = this._onUnexpectedError.bind(this);

    this.childProcess = childProcess;
    this._pendingDeferreds = {};
    this._onCallbacks = {};

    instances.push(this);

    // Listen for stdout messages dedicated to phridge
    childProcess.phridge.on("data", this._receive);

    // Add handlers for unexpected events
    childProcess.on("exit", this._onUnexpectedError);
    childProcess.on("error", this._onUnexpectedError);
    childProcess.stdin.on("error", this._onUnexpectedError);
    childProcess.stdout.on("error", this._onUnexpectedError);
    childProcess.stderr.on("error", this._onUnexpectedError);
};

/**
 * Starts the local websocket server
 *
 * @param {Function} resolve
 * @param {Function} reject
 */
Phantom.prototype.startLocalServer = function (resolve, reject) {
    var self = this;

    // Creates a local server for the websockets
    var server = http.createServer();

    server.listen(0, function () {
        var loaded = false;

        var connectionTimeout = setTimeout(function () {
            if (!loaded) {
                var err = new Error("websocket connection timeout");
                err.Phantom = self;
                reject(err);
            }
        }, 10 * 1000);

        // Sends the random port to the phantom
        self.childProcess.stdin.write(JSON.stringify({ port: server.address().port }) + os.EOL, "utf8");

        // Starts the websocket listener
        self._wss = new ws.Server({ server: server });

        self._wss.on("close", self._onUnexpectedError);

        self._wss.on("connection", function connection(spark) {
            loaded = true;
            clearTimeout(connectionTimeout);

            self._spark = spark;
            spark.on("message", self._receive);
            resolve(self);
        });
    });
};

/**
 * Stringifies the given function fn, sends it to PhantomJS and runs it in the scope of PhantomJS.
 * You may prepend any number of arguments which will be passed to fn inside of PhantomJS. Please note that all
 * arguments should be stringifyable with JSON.stringify().
 *
 * @param {...*} args
 * @param {Function} fn
 * @returns {Promise}
 */
Phantom.prototype.run = function (args, fn) {
    var self = this;

    args = arguments;

    return new Promise(function (resolve, reject) {
        args = slice.call(args);
        fn = args.pop();

        self._send(
            {
                action: "run",
                data: {
                    src: serializeFn(fn, args)
                }
            },
            args.length === fn.length
        ).then(resolve, reject);
    });
};

/**
 * Returns a new instance of a Page which can be used to run code in the context of a specific page.
 *
 * @returns {Page}
 */
Phantom.prototype.createPage = function () {
    var self = this;

    return new Page(self, pageId++);
};

/**
 * Creates a new instance of Page, opens the given url and resolves when the page has been loaded.
 *
 * @param {string} url
 * @returns {Promise}
 */
Phantom.prototype.openPage = function (url) {
    var page = this.createPage();

    return page.run(url, phantomMethods.openPage)
        .then(function () {
            return page;
        });
};

/**
 * Exits the PhantomJS process cleanly and cleans up references.
 *
 * @see http://msdn.microsoft.com/en-us/library/system.idisposable.aspx
 * @returns {Promise}
 */
Phantom.prototype.dispose = function () {
    var self = this;

    return new Promise(function dispose(resolve, reject) {
        if (self._isDisposed) {
            resolve();
            return;
        }

        // Remove handler for unexpected exits and add regular exit handlers
        self.childProcess.removeListener("exit", self._onUnexpectedError);
        self.childProcess.on("exit", self._afterExit);
        self.childProcess.on("exit", resolve);

        self.removeAllListeners();

        self.run(phantomMethods.exitPhantom).catch(function () { });

        self._beforeExit();
    });
};

/**
 * Prepares the given message and writes it to the websocket.
 *
 * @param {Object} message
 * @param {boolean} fnIsSync
 * @returns {Promise}
 * @private
 */
Phantom.prototype._send = function (message, fnIsSync) {
    var self = this;

    return new Promise(function (resolve, reject) {
        message.from = new Error().stack
            .split(/\n/g)
            .slice(1)
            .join("\n");
        message.id = nextRequestId++;

        self._pendingDeferreds[message.id] = {
            resolve: resolve,
            reject: reject
        };
        if (!fnIsSync) {
            self._schedulePing();
        }
        self._pending++;

        self._write(message);
    });
};

/**
 * Helper function that stringifies the given message-object, appends an end of line character
 * and writes it to the websocket.
 *
 * @param {Object} message
 * @private
 */
Phantom.prototype._write = function (message) {
    try {
        this._spark.send(JSON.stringify(message));
    } catch (e) {
        this._onUnexpectedError({ message: e });
    }
};

/**
 * Parses the given message via JSON.parse() and resolves or rejects the pending promise.
 *
 * @param {string} message
 * @private
 */
Phantom.prototype._receive = function (message) {
    if (message === "hi") {
        return;
    }

    message = JSON.parse(message);

    // pong messages are special
    if (message.status === "pong") {
        this._pingTimeoutId = null;

        // If we're still waiting for a message, we need to schedule a new ping
        if (this._pending > 0) {
            this._schedulePing();
        }
        return;
    }

    // callback messages are special
    if (message.status === "callback") {
        // If the callback is for page
        if (Number.isInteger(message.pageId)) {
            // And there is an callback handler for this page, then send the data to the handler
            if (this._onCallbacks[message.pageId]) {
                this._onCallbacks[message.pageId](message.data);
            }
            // If there is phantom callback handler, then send the data to the handler
        } else if (this.onCallback) {
            this.onCallback(message.data);
        }
        return;
    }

    this._resolveDeferred(message);
};

/**
 * Takes the required actions to respond on the given message.
 *
 * @param {Object} message
 * @private
 */
Phantom.prototype._resolveDeferred = function (message) {
    var deferred;

    deferred = this._pendingDeferreds[message.id];

    // istanbul ignore next because this is tested in a separated process and thus isn't recognized by istanbul
    if (!deferred) {
        // This happens when resolve() or reject() have been called twice
        if (message.status === "success") {
            throw new Error("Cannot call resolve() after the promise has already been resolved or rejected");
        } else if (message.status === "fail") {
            throw new Error("Cannot call reject() after the promise has already been resolved or rejected");
        }
    }

    delete this._pendingDeferreds[message.id];
    this._pending--;

    if (message.status === "success") {
        deferred.resolve(message.data);
    } else {
        deferred.reject(message.data);
    }
};

/**
 * Sends a ping to the PhantomJS process after a given delay.
 * Check out lib/phantom/start.js for an explanation of the ping action.
 *
 * @private
 */
Phantom.prototype._schedulePing = function () {
    if (this._pingTimeoutId !== null) {
        // There is already a ping scheduled. It's unnecessary to schedule another one.
        return;
    }
    if (this._isDisposed) {
        // No need to schedule a ping, this instance is about to be disposed.
        // Catches rare edge cases where a pong message is received right after the instance has been disposed.
        // @see https://github.com/peerigon/phridge/issues/41
        return;
    }
    this._pingTimeoutId = setTimeout(this._write, pingInterval, { action: "ping" });
};

/**
 * This function is executed before the process is actually killed.
 * If the process was killed autonomously, however, it gets executed postmortem.
 *
 * @private
 */
Phantom.prototype._beforeExit = function () {
    var index;

    this._isDisposed = true;

    index = instances.indexOf(this);
    index !== -1 && instances.splice(index, 1);
    clearTimeout(this._pingTimeoutId);

    // Seal the run()-method so that future calls will automatically be rejected.
    this.run = runGuard;

    // Closing the websocket server
    this._wss.close();
};

/**
 * This function is executed after the process actually exited.
 *
 * @private
 */
Phantom.prototype._afterExit = function () {
    var deferreds = this._pendingDeferreds;
    var errorMessage = "Cannot communicate with PhantomJS process: ";
    var error;

    if (this._unexpectedError) {
        errorMessage += this._unexpectedError.message;
        error = new Error(errorMessage);
        error.originalError = this._unexpectedError;
    } else {
        errorMessage += "Unknown reason";
        error = new Error(errorMessage);
        error.phantomClosed = true;
    }

    this.childProcess = null;

    // When there are still any deferreds, we must reject them now
    Object.keys(deferreds).forEach(function forEachPendingDeferred(id) {
        deferreds[id].reject(error);
        delete deferreds[id];
    });
};

/**
 * Will be called as soon as an unexpected IO error happened on the attached PhantomJS process. Cleans up everything
 * and emits an unexpectedError event afterwards.
 *
 * Unexpected IO errors usually happen when the PhantomJS process was killed by another party. This can occur
 * on some OS when SIGINT is sent to the whole process group. In these cases, node throws EPIPE errors.
 * (https://github.com/peerigon/phridge/issues/34).
 *
 * @private
 * @param {Error} error
 */
Phantom.prototype._onUnexpectedError = function (error) {
    var errorMessage;

    if (this._isDisposed) {
        return;
    }

    errorMessage = "PhantomJS exited unexpectedly";
    if (error && typeof error == "object") {
        error.message = errorMessage + ": " + error.message;
    } else {
        error = new Error(errorMessage);
    }
    this._unexpectedError = error;

    this._beforeExit();
    // Chainsaw against PhantomJS zombies
    this.childProcess.kill("SIGKILL");
    this._afterExit();

    this.emit("unexpectedExit", error);
};

/**
 * Will be used as "seal" for the run method to prevent run() calls after dispose.
 * Appends the original error when there was unexpected error.
 *
 * @returns {Promise}
 * @this Phantom
 */
function runGuard() {
    var err = new Error("Cannot run function");
    var cause = this._unexpectedError ? this._unexpectedError.message : "Phantom instance is already disposed";

    err.message += ": " + cause;
    err.originalError = this._unexpectedError;

    return Promise.reject(err);
}

module.exports = Phantom;

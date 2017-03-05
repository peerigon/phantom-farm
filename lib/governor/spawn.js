"use strict";

var childProcess = require("child_process");
var phantomjs = require("phantomjs-prebuilt");
var instances = require("./instances.js");

var initialMessage = "message to node: hi";

/**
 * Spawns a new PhantomJS process with the given phantom config. Returns a Promises/A+ compliant promise
 * which resolves when the process is ready to execute commands.
 *
 * @see http://phantomjs.org/api/command-line.html
 * @param {Object} phantomJsConfig
 * @returns {Promise}
 */
function spawn(port, args) {
    var child;

    return new Promise(function (resolve, reject) {
        function onStdout(chunk) {
            var message = chunk.toString("utf8");

            child.stdout.removeListener("data", onStdout);
            child.stderr.removeListener("data", onStderr);

            if (message.slice(0, initialMessage.length) === initialMessage) {
                resolve();
            } else {
                reject(new Error(message));
            }
        }

        // istanbul ignore next because there is no way to trigger stderr artificially in a test
        function onStderr(chunk) {
            var message = chunk.toString("utf8");

            child.stdout.removeListener("data", onStdout);
            child.stderr.removeListener("data", onStderr);

            reject(new Error(message));
        }

        args.push("--communication-port=" + port);

        child = childProcess.spawn(phantomjs.path, args);

        instances[port] = child;

        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);

        child.stdout.pipe(process.stdout);
        child.stderr.pipe(process.stderr);
    });
}

module.exports = spawn;

"use strict";

var config = require("./config.js");
var fs = require("fs");
var temp = require("temp");
var path = require("path");
var Phantom = require("./Phantom.js");
var forkStdout = require("./forkStdout.js");
var lift = require("./lift.js");
var governor = require("./governor.js");

var startScript = path.resolve(__dirname, "./phantom/start.js");
var writeFile = lift(fs.writeFile);
var close = lift(fs.close);
var open = lift(temp.open);
var initialMessage = "message to node: hi";

/**
 * Spawns a new PhantomJS process with the given phantom config. Returns a Promises/A+ compliant promise
 * which resolves when the process is ready to execute commands.
 *
 * @see http://phantomjs.org/api/command-line.html
 * @param {Object} phantomJsConfig
 * @returns {Promise}
 */
function spawn(phantomJsConfig) {
    var args;
    var configPath;
    var stdout;
    var stderr;

    phantomJsConfig = phantomJsConfig || {};

    // Saving a reference of the current stdout and stderr because this is (probably) the expected behaviour.
    // If we wouldn't save a reference, the config of a later state would be applied because we have to
    // do asynchronous tasks before piping the streams.
    stdout = config.stdout;
    stderr = config.stderr;

    /**
     * Step 1: Write the config
     */
    return open(null)
        .then(function writeConfig(info) {
            configPath = info.path;

            // Pass config items in CLI style (--some-config) separately to avoid Phantom's JSON config bugs
            // @see https://github.com/peerigon/phridge/issues/31
            args = Object.keys(phantomJsConfig)
                .filter(function filterCliStyle(configKey) {
                    return configKey.charAt(0) === "-";
                })
                .map(function returnConfigValue(configKey) {
                    var configValue = phantomJsConfig[configKey];

                    delete phantomJsConfig[configKey];

                    return configKey + "=" + configValue;
                });

            return writeFile(info.path, JSON.stringify(phantomJsConfig))
                .then(function () {
                    return close(info.fd);
                });
        })
        /**
         * Step 2: Start PhantomJS with the config path and pipe stderr and stdout.
         */
        .then(function startPhantom() {
            return new Promise(function (resolve, reject) {
                args.push(
                    "--config=" + configPath,
                    startScript,
                    configPath
                );

                // Our destination streams should not be ended if the childProcesses exists
                // thus { end: false }
                // @see https://github.com/peerigon/phridge/issues/27
                if (stdout) {
                    governor().stdout.pipe(stdout, { end: false });
                } else {
                    governor().stdout.pipe(process.stdout, { end: false });
                }

                if (stderr) {
                    governor().stderr.pipe(stderr, { end: false });
                } else {
                    governor().stderr.pipe(process.stderr, { end: false });
                }

                var phantom = new Phantom();
                phantom.startLocalServer(resolve, reject).then(function () {
                    governor().send({ action: "spawn", port: phantom.port, args: args });
                });
            });
        })
}

module.exports = spawn;

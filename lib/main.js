exports.config = require("./config.js");
exports.spawn = require("./spawn.js");
exports.disposeAll = require("./disposeAll.js");

var cp = require('child_process');

var governor = require("./governor.js");
governor(cp.fork(__dirname + "/governor/start.js", [], {
    silent: true,
    execArgv: process.execArgv.filter(function (s) { return s.indexOf("--debug-brk") != 0 })
}));

governor().stdout.pipe(exports.config.stdout, { end: false });
governor().stderr.pipe(exports.config.stderr, { end: false });
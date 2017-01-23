exports.config = require("./config.js");
exports.spawn = require("./spawn.js");
exports.disposeAll = require("./disposeAll.js");

var cp = require('child_process');

require("./governor.js")(cp.fork(__dirname + "/governor/start.js", [], { silent: true }));
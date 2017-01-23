"use strict";

var spawn = require("./spawn.js");
var instances = require("./instances.js");

process.on('message', function (message) {
    switch (message.action) {
        case "spawn":
            spawn(message.port, message.args);
            break;
        case "kill":
            instances[message.port].kill("SIGKILL");
            break;
    }
});
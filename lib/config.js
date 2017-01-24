"use strict";

var governor = require("./governor.js");

var stdout = process.stdout;
var stderr = process.stderr;

module.exports = {
    /**
     * A writable stream where phridge will pipe PhantomJS' stdout messages.
     *
     * @type {stream.Writable}
     * @default process.stdout
     */
    get stdout() {
        return stdout;
    },
    set stdout(value) {
        if (!value)
            stdout = process.stdout;
        else
            stdout = value;

        governor().stdout.pipe(stdout, { end: false });
    },

    /**
     * A writable stream where phridge will pipe PhantomJS' stderr messages.
     *
     * @type {stream.Writable}
     * @default process.stderr
     */
    get stderr() {
        return stderr;
    },
    set stderr(value) {
        if (!value)
            stderr = process.stderr;
        else
            stderr = value;

        governor().stderr.pipe(stderr, { end: false });
    }
};
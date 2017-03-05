"use strict";

/**
 * Stores the governor process.
 *
 * @private
 * @type child_process
 */
var child;

module.exports = function (newChild) {
    if (newChild)
        child = newChild;

    return child;
};
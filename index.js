var AtomicHooks = require('level-atomichooks');
var uuid = require('node-uuid');
var base60fill = require('base60fill');
var async = require('async');
var through = require('through');
var stream = require('stream');
var util = require('util');

function IndexToKeyValue(db, opts) {
    this.db = db;
    this.dbopts = opts;
    streamopts = {};
    streamopts.highWaterMark = 10;
    streamopts.objectMode = true;
    streamopts.allowHalfOpen = false;
    stream.Transform.call(this, streamopts);
}

util.inherits(IndexToKeyValue, stream.Transform);

(function () {
    this._transform = function (entry, encoding, next) {
        var key = entry.value;
        if (this.dbopts.values) {
            this.db.get(key, this.dbopts, function (err, value) {
                if (!err && value) {
                    if (this.dbopts.keys) {
                        this.push({key: key, value: value});
                    } else {
                        this.push(value);
                    }
                }
                next();
            }.bind(this));
        } else {
            this.push(key);
        }
    };
}).call(IndexToKeyValue.prototype);

function Level2i(db, opts) {
    if (!db.atomichooks) {
        db = AtomicHooks(db);
    }

    db.opts2i = opts || {};
    db.opts2i.sep = db.opts2i.sep || '!';

    db.registerPutHook(function (key, value, opts, batch, callback) {
        var indexes = {bin: [], int: []};
        if (Array.isArray(opts.indexes)) {
            opts.indexes.forEach(function (index) {
                var idx, idx2;
                idx = index.key.indexOf('_int');
                if (idx !== -1) {
                    indexes.int[index.key.substr(0, idx)] = index.value;
                } else {
                    idx2 = index.key.indexOf('_bin');
                    if (idx2 !== -1) {
                        index.key = index.key.substr(0, idx2);
                    }
                    indexes.bin[index.key] = index.value;
                }
            });
            console.log("updating indexes");
            db._updateIndexes(key, indexes, opts, callback);
        } else {
            callback();
        }
    });

    db.registerReadStreamOverride(function (opts) {
        var stream;
        if (typeof opts.values === 'undefined') {
            opts.values = true;
        }
        if (typeof opts.keys === 'undefined') {
            opts.keys = true;
        }
        if (opts.index) {
            if (opts.index.indexOf(-4) ===  '_int') {
                opts.index = opts.index.substr(0, opts.index.length - 4);
                opts.start = base64fill.base60Fill(opts.start, 10);
                opts.end = base64fill.base60Fill(opts.end, 10);
            } else {
                opts.index = opts.index.substr(0, opts.index.length - 4);
                opts.start = ['__index__', opts.index, opts.start].join(db.opts2i.sep);
                opts.end = ['__index__', opts.index, opts.end].join(db.opts2i.sep);
            }

            console.log(opts);

            stream = db.parent.createReadStream({
                start: opts.start,
                end: opts.end,
                reverse: opts.reverse,
                keys: true,
                values: true,
            });
            
            return stream.pipe(new IndexToKeyValue(db.parent, opts));

        } else {
            return db.parent.createReadStream(opts);
        }
    });

    db.registerDelHook(function (key, opts, batch, callback) {
        db.parent.get(['__meta__', key].join(db.opts2i.sep), opts, function (err, meta) {
            if (err || !meta) {
                meta = {bin_indexes: {}, int_indexes: {}};
            }
            async.parallel(
            [function (pcb) {
                async.each(Object.keys(meta.bin_indexes),
                function (field, ecb) {
                    console.log(meta);
                    console.log(field);
                    db._deleteIndex(key, meta.bin_indexes[field].key, field, meta.bin_indexes[field].value, opts, ecb);
                }, pcb);
            },
            function (pcb) {
                async.each(Object.keys(meta.int_indexes),
                function (field, ecb) {
                    db._deleteIndex(key, meta.int_indexes[field].key, field, meta.int_indexes[field].value, opts, ecb);
                }, pcb);
            },
            function (pcb) {
                db.parent.del(['__meta__', key].join(db.opts2i.sep), opts, pcb);
            }],
            callback);
        });
    });

    db.increment = function (key, amount, opts, callback) {
        db.parent.get(key, opts, function (err, val) {
            if (err || !val) {
                count = 0;
            } else {
                count = parseInt(val, 10);
            }
            console.log(key, val, count, amount);
            count += amount;
            if (count === 0) {
                db.parent.del(key, opts, function (err) {
                    callback(err, count);
                });
            } else {
                db.parent.put(key, count, opts, function (err) {
                    callback(err, count);
                });
            }
        });
    };

    db._updateIndex = function (key, field, oldikey, oldvalue, newvalue, opts, callback) {
        async.waterfall([
            function (acb) {
                db._deleteIndex(key, oldikey, field, oldvalue, opts, function (err) {
                    acb(null);
                });
            }.bind(this),
            function (acb) {
                db._saveIndex(key, field, newvalue, opts, acb);
            }.bind(this),
        ],
        function (err, index) {
            callback(err, index);
        });
    };

    db._saveIndex = function (key, field, value, opts, callback) {
        async.waterfall([
            function (acb) {
                var ikey = ['__index__', field, value, uuid()].join(db.opts2i.sep);
                db.parent.put(ikey, key, opts, function (err) {
                    var index = {key: ikey, value: value};
                    acb(err, index);
                });
            }.bind(this),
            function (index, acb) {
                db.increment(['__total__', '__index_value__', field, value].join(db.opts2i.sep), 1, opts, function (err) {
                    acb(err, index);
                });
            },
        ],
        function (err, index) {
            callback(err, index);
        });
    };

    db._deleteIndex = function (key, oldikey, field, value, opts, callback) {
        async.waterfall([
            function (acb) {
                db.parent.del(oldikey, opts, acb);
            },
            function (acb) {
                db.increment(['__total__', '__index_value__', field, value].join(db.opts2i.sep), -1, opts, acb);
            }
        ],
        callback);
    };

    db._updateIndexes = function (key, indexes, opts, callback) {
        db.parent.get(['__meta__', key].join(db.opts2i.sep), opts, function (err, meta) {
            var iidx, field, old_value;
            if (err || !meta) {
                meta = {bin_indexes: {}, int_indexes: {}};
            }
            async.parallel(
                [function (pcb) {
                    //update binary indexes
                    if (!indexes.hasOwnProperty('bin')) {
                        pbc();
                        return;
                    }
                    async.each(Object.keys(indexes.bin), function (field, ecb) {
                        var newvalue = String(indexes.bin[field]);
                        if (meta.bin_indexes.hasOwnProperty(field)) {
                            if (newvalue !== meta.bin_indexes[field].value) {
                                db._updateIndex(key, field, meta.bin_indexes[field].key, meta.bin_indexes[field].value, newvalue, opts, function (err, index) {
                                    if (index) {
                                        meta.bin_indexes[field] = index;
                                    }
                                    ecb(err);
                                });
                            } else {
                                ecb(null);
                            }
                        } else {
                            db._saveIndex(key, field, newvalue, opts, function (err, index) {
                                if (index) {
                                    meta.bin_indexes[field] = index;
                                }
                                ecb(err);
                            });
                        }
                    }.bind(this),
                    function (err, index) {
                        pcb(err);
                    });
                }.bind(this),
                function (pcb) {
                    //update integer indexes
                    async.each(Object.keys(indexes.int), function (field, ecb) {
                        var newvalue = base64fill.base60Fill(parseInt(indexes.int[field], 10), 10);
                        if (meta.int_indexes.hasOwnProperty(field)) {
                            if (newvalue !== meta.bin_indexes[field].value) {
                                db._updateIndex(key, field, meta.int_indexes[field].key, meta.bin_indexes[field].value, newvalue, opts, function (err, index) {
                                    if (index) {
                                        meta.bin_indexes[field] = index;
                                    }
                                    ecb(err);
                                });
                            } else {
                                ecb(null);
                            }
                        } else {
                            db._saveIndex(key, field, newvalue, opts, function (err, index) {
                                if (index) {
                                    meta.bin_indexes[field] = index;
                                }
                                ecb(err);
                            });
                        }
                    }.bind(this),
                    function (err, index) {
                        pcb(err);
                    });
                }.bind(this)],
                function (err) {
                    //update the meta object
                    db.parent.put(['__meta__', key].join(db.opts2i.sep), meta, opts, callback);
                }.bind(this)
            );
        }.bind(this));
    };

    return db;
}

module.exports = Level2i;

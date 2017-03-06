var request = require('request')
var fs = require('fs')
var path = require('path')
var progress = require('progress-stream')
var prettyBytes = require('pretty-bytes')
var throttle = require('throttleit')
var EventEmitter = require('events').EventEmitter
var debug = require('debug')('nugget')

function noop() {}

module.exports = function(url, opts, cb) {

    opts.singleTarget = true

    var defaultProps = {}

    if (opts.sockets) {
        var sockets = +opts.sockets
        defaultProps.pool = { maxSockets: sockets }
    }

    if (opts.proxy) {
        defaultProps.proxy = opts.proxy
    }

    if (opts.strictSSL !== null) {
        defaultProps.strictSSL = opts.strictSSL
    }

    if (Object.keys(defaultProps).length > 0) {
        request = request.defaults(defaultProps)
    }

    debug('start dl', url);

    var dl = startDownload(url, opts, function done(err) {
        debug('done dl', url)
        if (err) {
            return cb(err)
        }
        cb(null);
    })


    dl.on('start', function(progressStream) {
        throttledRender()
    })

    dl.on('progress', function(data) {
            debug('progress', url, data.percentage)

            dl.speed = data.speed
            if (dl.percentage === 100) render()
            else throttledRender()
        })

    render()
    var throttledRender = throttle(render, opts.frequency || 250)

    // if (opts.singleTarget) return downloads[0]
    // else return downloads

    return dl;

    function render() {
        var pct = dl.percentage
        var speed = dl.speed
        var total = dl.fileSize

        dl.emit('percentage', {
            percent: pct.toFixed(1),
            speed: prettyBytes(speed || 0),
            total: prettyBytes(total || 0)
        });
    }

    function startDownload(url, opts, cb) {
        var targetName = path.basename(url).split('?')[0]
        if (opts.singleTarget && opts.target) targetName = opts.target
        var target = path.resolve(opts.dir || process.cwd(), targetName)
        if (opts.resume) {
            resume(url, opts, cb)
        } else {
            download(url, opts, cb)
        }

        var progressEmitter = new EventEmitter()
        progressEmitter.target = target
        progressEmitter.speed = 0
        progressEmitter.percentage = 0

        return progressEmitter

        function resume(url, opts, cb) {
            fs.stat(target, function(err, stats) {
                if (err && err.code === 'ENOENT') {
                    return download(url, opts, cb)
                }
                if (err) {
                    return cb(err)
                }
                var offset = stats.size
                var req = request.get(url)

                req.on('error', cb)
                req.on('response', function(resp) {
                    resp.destroy()

                    var length = parseInt(resp.headers['content-length'], 10)

                    // file is already downloaded.
                    if (length === offset) return cb()

                    if (!isNaN(length) && length > offset && /bytes/.test(resp.headers['accept-ranges'])) {
                        opts.range = [offset, length]
                    }

                    download(url, opts, cb)
                })
            })
        }

        function download(url, opts, cb) {
            var headers = opts.headers || {}
            if (opts.range) {
                headers.Range = 'bytes=' + opts.range[0] + '-' + opts.range[1]
            }
            var read = request(url, { headers: headers })

            read.on('error', cb)
            read.on('response', function(resp) {
                debug('response', url, resp.statusCode)
                if (resp.statusCode > 299 && !opts.force) return cb(new Error('GET ' + url + ' returned ' + resp.statusCode))
                var write = fs.createWriteStream(target, { flags: opts.resume ? 'a' : 'w' })
                write.on('error', cb)
                write.on('finish', cb)

                var fullLen
                var contentLen = Number(resp.headers['content-length'])
                var range = resp.headers['content-range']
                if (range) {
                    fullLen = Number(range.split('/')[1])
                } else {
                    fullLen = contentLen
                }

                progressEmitter.fileSize = fullLen
                if (range) {
                    var downloaded = fullLen - contentLen
                }
                var progressStream = progress({ length: fullLen, transferred: downloaded }, onprogress)
                progressEmitter.emit('start', progressStream)

                resp
                    .pipe(progressStream)
                    .pipe(write)
            })

            function onprogress(p) {
                var pct = p.percentage
                progressEmitter.progress = p
                progressEmitter.percentage = pct
                progressEmitter.emit('progress', p)
            }
        }
    }
}
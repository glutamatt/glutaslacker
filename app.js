var envConfig = (process.env.SLACK_TOKEN && process.env.DROPBOX_KEY && process.env.DROPBOX_TOKEN) ? {
    slackToken: process.env.SLACK_TOKEN,
    dropboxKey: process.env.DROPBOX_KEY,
    dropboxToken: process.env.DROPBOX_TOKEN,
} : false;
var appConfig = envConfig || require('./appConfig')
var slackToken = appConfig.slackToken
var dropboxCredentials = {
    key: appConfig.dropboxKey,
    token: appConfig.dropboxToken
}

var express = require('express');
var httpJson = require('request-json');
var WebSocket = require('ws');
var async = require('async')
var Redis = require('ioredis');
var dateFormat = require('dateformat');
var logger = require('tracer').colorConsole();
var slackClient = httpJson.createClient('https://slack.com/api/');
var app = express();
var redis = new Redis(process.env.REDISCLOUD_URL || null)
var Dropbox = require("dropbox");
var dropbox =  new Dropbox.Client(dropboxCredentials);

var persistMessage = function (bucket, channel, message){
    var now = Date.now()
    message.ts = now
    redis.sadd('buckets', bucket)
    redis.sadd('channels_by_bucket:' + bucket, channel)
    redis.zadd('messages_by_bucket_channel:' + bucket + ':' + channel, now, JSON.stringify(message))
}

var isDataPersistable = function (data) {
    return data.type == 'message' && !('reply_to' in data)
}

var getBucketFileContent = function(bucket, callback) {
    var channelContents = []
    redis.smembers('channels_by_bucket:' + bucket, function(err, channels) {
        err || async.each(channels, function(channel, cb) {
            redis.zrange('messages_by_bucket_channel:' + bucket + ':' + channel, 0, -1, function(err, messages) {
                err || channelContents.push('#' + channel + "\n" + messages.join("\n"))
                cb(err)
            })
        }, function(err){ callback(err, err || channelContents.join("\n")) })
    })
}

var cleanBucket = function(bucket, callback) {
    redis.srem('buckets', bucket)
    redis.smembers('channels_by_bucket:' + bucket, function(err, channels) {
        err ? callback(err) : async.each(channels, function(channel, cb) {
            redis.del('messages_by_bucket_channel:' + bucket + ':' + channel, cb)
        }, function (err) { err ? callback(err) : redis.del('channels_by_bucket:' + bucket, callback) })
    })
}

var onBucketChange = function(previousBucket, newBucket) {
    async.waterfall([
        function (callback)          { getBucketFileContent(previousBucket, callback)},
        function (content, callback) { dropbox.authenticate( function(err, client){ callback(err, content)})},
        function (content, callback) { dropbox.writeFile(previousBucket + ".slack", content, callback)},
        function (stats, callback)   { cleanBucket(previousBucket, callback) }
        //todo : http://coffeedoc.info/github/dropbox/dropbox-js/master/classes/Dropbox/Client.html#resumableUploadStep-instance
    ], function (err, results) { err && logger.log(err)})
}

var getCurrentBucket = (function (onChanged) {
    var get = function() { return dateFormat(new Date(), 'yyyymmddHH')}
    var currentBucket = get()
    return function () { 
        var current = get()
        if (current === currentBucket) return current
        onChanged(currentBucket, current)
        currentBucket = current
        return current
    }
})(onBucketChange);

slackClient.get("rtm.start?token="+slackToken, function(err, res, body) {
    if (err) { logger.log(err) ; return }
    var ws = new WebSocket(body.url);
    ws.on('message', function(raw) {
        var data = JSON.parse(raw)
        isDataPersistable(data) && persistMessage(getCurrentBucket(), data.channel, {user:data.user, text:data.text})
    })
})

var keepAliveUrl = '';
var keepAliveSecure = false;
app.get('/', function (req, res) {
    if (req.headers.host) {
        keepAliveSecure = req.secure
        keepAliveUrl = req.headers.host + '/?keepAlive';
    }
    res.send('Ping active on ' + keepAliveUrl);
});

setInterval(function() {
    if (!keepAliveUrl) return
    var date = new Date()
    date.setTime((120 + date.getTimezoneOffset())*60*1000 + Date.now()) // set Paris Time
    var hour = dateFormat(date, 'H')
    if (hour > 7 && hour < 23) {
        var scheme = 'http' + (keepAliveSecure ? 's' : '')
        require(scheme).get(scheme + '://' + keepAliveUrl)
    }
}, 1000 * 60 * 15)

var server = app.listen(process.env.PORT || 3000, function () {
  var adress = server.address()
  logger.log('Example app listening at http://%s:%s', adress.address, adress.port)
})

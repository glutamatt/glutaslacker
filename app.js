var appConfig = require('./appConfig')
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
var redis = new Redis();
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

var onBucketChange = function(previousBucket, newBucket) {
    async.waterfall([
        function (callback)          { getBucketFileContent(previousBucket, callback)},
        function (content, callback) { dropbox.authenticate( function(err, client){ callback(err, content)})},
        function (content, callback) { dropbox.writeFile(previousBucket + ".slack", content, callback)}
    ], function (err, results) { err && logger.log(err)})
}

var getCurrentBucket = (function (onChanged) {
    var get = function() { return dateFormat(new Date(), 'yyyymmddHHMM')}
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

app.get('/', function (req, res) {
  res.send('Hello World!');
});

var server = app.listen(3000, function () {
  var adress = server.address()
  logger.log('Example app listening at http://%s:%s', adress.address, adress.port)
})

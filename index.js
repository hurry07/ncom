var net = require('net');
var tls = require('tls');
var crypto = require('crypto');
var formatter = require('sc-formatter');
var EventEmitter = require('events').EventEmitter;

// --------------------------
// ComSocket
// --------------------------
/**
 * @param options 可以使用现有的 socket 建立连接, 可以指定参数新建连接
 * @param id
 * @constructor
 */
var ComSocket = function (options, id) {
  var self = this;

  var dataInboundBuffer = '';
  var dataOutboundBuffer = '';
  var endSymbol = '\u0017';
  var endSymbolRegex = new RegExp(endSymbol, 'g'); // 每个消息通过 u0017 分开
  var flushOutTimeout = null;

  self.id = id;
  self.connected = false;
  self.batchDuration = 5; // 5 milliseconds

  if (options instanceof net.Socket) {
    self.socket = options;
    self.authorized = options.authorized;
  } else {
    self.socket = new net.Socket(options);
  }

  self.socket.on('error', function (err) {
    self.emit('error', err);
  });

  /**
   * 如果给定 socket 连接, 那么可能需要手动开始连接
   */
  self.connect = function () {
    self.socket.connect.apply(self.socket, arguments);
  };

  /**
   * endSymbol 是分隔符, 每个消息结束时都尾随分隔符, 所以 split 方法 length - 1 元素应该是 [].
   * 如果有消息没有接受成功, length - 1 保存消息片段直到接收到 endSymbol 为止
   */
  self.socket.on('data', function (data) {
    dataInboundBuffer += data.toString();
    var messages = dataInboundBuffer.split(endSymbol);
    var num = messages.length - 1;
    dataInboundBuffer = messages[num];

    for (var i = 0; i < num; i++) {
      self.socket.emit('message', formatter.decode(messages[i]));
    }
  });

  self.socket.on('connect', function () {
    self.connected = true;
  });

  self.socket.on('close', function () {
    self.connected = false;
  });

  /**
   * 注册事件监听者, 如果是 error 事件, 注册到自身上, 其余注册到 socket 上.
   * @param event
   * @param callback
   */
  self.on = function (event, callback) {
    if (event === 'error') {
      EventEmitter.prototype.on.call(self, event, callback);
    } else {
      self.socket.on(event, callback);
    }
  };

  self.listeners = function () {
    self.socket.listeners.apply(self.socket, arguments);
  };

  self.removeListener = function () {
    self.socket.removeListener.apply(self.socket, arguments);
  };

  self.removeAllListeners = function () {
    self.socket.removeAllListeners.apply(self.socket, arguments);
  };

  self._flushOutboundBuffer = function () {
    self.socket.write(dataOutboundBuffer);
    dataOutboundBuffer = '';
    flushOutTimeout = null;
  };

  /**
   * 写入数据
   * @param data
   * @param writeOptions
   */
  self.write = function (data, writeOptions) {
    var str, formatError;
    writeOptions = writeOptions || {};

    var filters = writeOptions.filters;

    // 如果编码出现问题
    try {
      str = formatter.encode(data).replace(endSymbolRegex, '');
    } catch (err) {
      formatError = err;
      self.emit('error', formatError);
    }

    // 通过 filters
    if (!formatError) {
      if (filters) {
        var len = filters.length;
        for (var i = 0; i < len; i++) {
          str = filters[i](str);
        }
      }

      // 批量发送, 等待 batchDuration, 然后把积累的消息一起发送.
      if (writeOptions.batch) {
        dataOutboundBuffer += str + endSymbol;
        if (!flushOutTimeout) {
          flushOutTimeout = setTimeout(self._flushOutboundBuffer, self.batchDuration);
        }
      } else {
        self.socket.write(str + endSymbol);
      }
    }
  };

  /**
   * Half-closes the socket. i.e., it sends a FIN packet. It is possible the server will still send some data.
   */
  self.end = function () {
    self.socket.end();
  };

  /**
   * Ensures that no more I/O activity happens on this socket. Only necessary in case of errors (parse error or so).
   * 立即停止
   */
  self.destroy = function () {
    self.socket.destroy();
  };
};

ComSocket.prototype = Object.create(EventEmitter.prototype);

// --------------------------
// ComServer
// --------------------------
var ComServer = function (options) {
  var self = this;

  self._options = options || {};

  var server;

  if (self._options.secure) {
    server = tls.createServer(options);
  } else {
    server = net.createServer(options);
  }
  server.on('error', function (err) {
    self.emit('error', err);
  });

  var idTrailer = 0;

  /**
   * 产生唯一id
   * @param callback
   * @return {*}
   */
  var generateId = function (callback) {
    return crypto.randomBytes(32, function (err, buffer) {
      if (err) {
        callback(null);
      } else {
        idTrailer++;
        callback(buffer.toString('hex') + '-' + idTrailer);
      }
    });
  };

  self.listen = function () {
    server.listen.apply(server, arguments);
  };

  /**
   * 接受到 data 西欧阿西, 饭后
   */
  server.on('connection', function (socket) {
    var tempBuffer = [];

    // 缓冲接受到的数据, 分割后再次抛出
    var bufferData = function (data) {
      tempBuffer.push(data.toString());
    };
    socket.on('data', bufferData);

    generateId(function (id) {
      socket.removeListener('data', bufferData);
      var comSocket = new ComSocket(socket, id);
      comSocket.connected = true;
      self.emit('connection', comSocket);
      var len = tempBuffer.length;
      for (var i = 0; i < len; i++) {
        socket.emit('data', tempBuffer[i]);
      }
    });
  });

  // connection, error 事件绑定到 ComServer 对象, 其余事件绑定到 socket.
  self.on = function (event, callback) {
    if (event === 'connection' || event === 'error') {
      EventEmitter.prototype.on.call(self, event, callback);
    } else {
      server.on(event, callback);
    }
  };

  self.removeListener = function () {
    EventEmitter.prototype.removeListener.apply(self, arguments);
    server.removeListener.apply(server, arguments);
  };

  self.removeAllListeners = function () {
    EventEmitter.prototype.removeAllListeners.apply(self, arguments);
    server.removeAllListeners.apply(server, arguments);
  };

  self.close = function (callback) {
    server.close(callback);
  };
};

ComServer.prototype = Object.create(EventEmitter.prototype);

var createServer = function () {
  var options, listener;
  if (arguments[1]) {
    options = arguments[0];
    listener = arguments[1];
  } else if (arguments[0] instanceof Function) {
    listener = arguments[0];
  } else {
    options = arguments[0];
  }

  var server = new ComServer(options);
  if (listener) {
    server.on('connection', listener);
  }
  return server;
};

module.exports.ComSocket = ComSocket;
module.exports.ComServer = ComServer;
module.exports.createServer = createServer;

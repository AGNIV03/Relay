import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';

/// Minimal Google Cast v2 (CASTV2) client: a TLS socket to the device on port
/// 8009 carrying length-prefixed `CastMessage` protobufs whose payloads are JSON.
/// Only what the Default Media Receiver needs is implemented: connection,
/// heartbeat, receiver (launch / volume / status) and media namespaces.
///
/// Wire format (cast_channel.proto, hand-encoded to avoid a protobuf dep):
///   1 protocol_version (varint, 0 = CASTV2_1_0)
///   2 source_id        (string)
///   3 destination_id   (string)
///   4 namespace        (string)
///   5 payload_type     (varint, 0 = STRING)
///   6 payload_utf8     (string)
///   7 payload_binary   (bytes, unused)
class CastChannel {
  final String host;
  final int port;
  CastChannel(this.host, this.port);

  static const nsConnection = 'urn:x-cast:com.google.cast.tp.connection';
  static const nsHeartbeat = 'urn:x-cast:com.google.cast.tp.heartbeat';
  static const nsReceiver = 'urn:x-cast:com.google.cast.receiver';
  static const nsMedia = 'urn:x-cast:com.google.cast.media';

  /// Our sender id. Unique per connection so the receiver tracks us separately
  /// from other phones / browsers controlling the same device.
  final String senderId = 'sender-relay-${DateTime.now().millisecondsSinceEpoch % 100000}';

  SecureSocket? _socket;
  final _buf = BytesBuilder(copy: false);
  Timer? _heartbeat;
  int _reqId = 1;
  final _pending = <int, Completer<Map<String, dynamic>>>{};
  final _messages = StreamController<CastMessage>.broadcast();
  bool _closed = false;

  /// Every JSON message received (all namespaces).
  Stream<CastMessage> get messages => _messages.stream;

  /// Completes when the socket closes (either side).
  final _closedC = Completer<void>();
  Future<void> get done => _closedC.future;
  bool get isOpen => _socket != null && !_closed;

  Future<void> connect() async {
    // Cast devices present a self-signed (device-certificate) chain.
    final s = await SecureSocket.connect(host, port,
        onBadCertificate: (_) => true, timeout: const Duration(seconds: 8));
    _socket = s;
    s.listen(_onData, onDone: _onClosed, onError: (Object _) => _onClosed(), cancelOnError: true);
    send(nsConnection, 'receiver-0', {'type': 'CONNECT'});
    _heartbeat = Timer.periodic(const Duration(seconds: 5), (_) {
      send(nsHeartbeat, 'receiver-0', {'type': 'PING'});
    });
  }

  void send(String namespace, String destination, Map<String, dynamic> payload) {
    final s = _socket;
    if (s == null || _closed) return;
    final body = _encode(senderId, destination, namespace, jsonEncode(payload));
    final frame = Uint8List(4 + body.length);
    ByteData.view(frame.buffer).setUint32(0, body.length);
    frame.setRange(4, frame.length, body);
    try {
      s.add(frame);
    } catch (e) {
      debugPrint('cast send failed: $e');
      _onClosed();
    }
  }

  /// Send with a fresh requestId and wait for the reply carrying it.
  Future<Map<String, dynamic>> request(String namespace, String destination,
      Map<String, dynamic> payload,
      {Duration timeout = const Duration(seconds: 10)}) {
    final id = _reqId++;
    final c = Completer<Map<String, dynamic>>();
    _pending[id] = c;
    send(namespace, destination, {...payload, 'requestId': id});
    return c.future.timeout(timeout, onTimeout: () {
      _pending.remove(id);
      throw TimeoutException('Cast request ${payload['type']} timed out');
    });
  }

  /// Fire-and-forget with a requestId (the reply arrives as a status message).
  void command(String namespace, String destination, Map<String, dynamic> payload) =>
      send(namespace, destination, {...payload, 'requestId': _reqId++});

  void _onData(Uint8List data) {
    _buf.add(data);
    var bytes = _buf.takeBytes();
    var off = 0;
    while (bytes.length - off >= 4) {
      final len = ByteData.view(bytes.buffer, bytes.offsetInBytes + off, 4).getUint32(0);
      if (bytes.length - off - 4 < len) break;
      final msg = _decode(Uint8List.sublistView(bytes, off + 4, off + 4 + len));
      off += 4 + len;
      if (msg != null) _dispatch(msg);
    }
    if (off < bytes.length) _buf.add(Uint8List.sublistView(bytes, off));
  }

  void _dispatch(CastMessage m) {
    if (m.namespace == nsHeartbeat) {
      if (m.json['type'] == 'PING') send(nsHeartbeat, m.sourceId, {'type': 'PONG'});
      return;
    }
    if (m.namespace == nsConnection && m.json['type'] == 'CLOSE' && m.sourceId == 'receiver-0') {
      _onClosed();
      return;
    }
    final rid = m.json['requestId'];
    if (rid is int && rid != 0) {
      final c = _pending.remove(rid);
      if (c != null && !c.isCompleted) c.complete(m.json);
    }
    if (!_messages.isClosed) _messages.add(m);
  }

  void _onClosed() {
    if (_closed) return;
    _closed = true;
    _heartbeat?.cancel();
    for (final c in _pending.values) {
      if (!c.isCompleted) c.completeError(const SocketException('Cast connection closed'));
    }
    _pending.clear();
    try {
      _socket?.destroy();
    } catch (_) {}
    _socket = null;
    if (!_closedC.isCompleted) _closedC.complete();
  }

  Future<void> close() async {
    if (_closed) return;
    send(nsConnection, 'receiver-0', {'type': 'CLOSE'});
    try {
      await _socket?.flush();
    } catch (_) {}
    _onClosed();
    await _messages.close();
  }

  // ---- protobuf (just the CastMessage shape) ----
  static Uint8List _encode(String src, String dst, String ns, String payload) {
    final b = BytesBuilder();
    void varint(int v) {
      while (v >= 0x80) {
        b.addByte((v & 0x7f) | 0x80);
        v >>= 7;
      }
      b.addByte(v);
    }

    void str(int field, String s) {
      final bytes = utf8.encode(s);
      varint((field << 3) | 2);
      varint(bytes.length);
      b.add(bytes);
    }

    varint(1 << 3);
    varint(0); // CASTV2_1_0
    str(2, src);
    str(3, dst);
    str(4, ns);
    varint(5 << 3);
    varint(0); // STRING
    str(6, payload);
    return b.toBytes();
  }

  static CastMessage? _decode(Uint8List d) {
    var i = 0;
    int varint() {
      var result = 0, shift = 0;
      while (i < d.length) {
        final byte = d[i++];
        result |= (byte & 0x7f) << shift;
        if (byte & 0x80 == 0) break;
        shift += 7;
      }
      return result;
    }

    String? src, dst, ns, payload;
    try {
      while (i < d.length) {
        final key = varint();
        final field = key >> 3, wire = key & 7;
        if (wire == 0) {
          varint();
        } else if (wire == 2) {
          final len = varint();
          final bytes = Uint8List.sublistView(d, i, i + len);
          i += len;
          switch (field) {
            case 2:
              src = utf8.decode(bytes);
            case 3:
              dst = utf8.decode(bytes);
            case 4:
              ns = utf8.decode(bytes);
            case 6:
              payload = utf8.decode(bytes);
          }
        } else if (wire == 5) {
          i += 4;
        } else if (wire == 1) {
          i += 8;
        } else {
          return null;
        }
      }
      if (ns == null || payload == null) return null;
      final json = jsonDecode(payload);
      if (json is! Map<String, dynamic>) return null;
      return CastMessage(src ?? '', dst ?? '', ns, json);
    } catch (_) {
      return null;
    }
  }
}

class CastMessage {
  final String sourceId;
  final String destinationId;
  final String namespace;
  final Map<String, dynamic> json;
  CastMessage(this.sourceId, this.destinationId, this.namespace, this.json);
  String? get type => json['type'] as String?;
}

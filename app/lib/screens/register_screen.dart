import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_state.dart';
import '../theme.dart';

/// Create an account with an invite code (from the login screen). The code is
/// checked live against the server as it's typed; on success the user is signed
/// in exactly like a normal login.
class RegisterScreen extends StatefulWidget {
  final String initialServer;
  const RegisterScreen({super.key, this.initialServer = ''});
  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

enum _CodeState { empty, checking, valid, invalid, unknown }

class _RegisterScreenState extends State<RegisterScreen> {
  late final TextEditingController _server;
  final _code = TextEditingController();
  final _user = TextEditingController();
  final _pass = TextEditingController();
  final _confirm = TextEditingController();
  Timer? _debounce;
  _CodeState _codeState = _CodeState.empty;
  int _checkSeq = 0;
  String? _error;
  bool _busy = false;

  static final _userPattern = RegExp(r'^[a-zA-Z0-9_.-]{3,32}$');

  @override
  void initState() {
    super.initState();
    _server = TextEditingController(
        text: widget.initialServer.isNotEmpty ? widget.initialServer : 'https://');
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _server.dispose();
    _code.dispose();
    _user.dispose();
    _pass.dispose();
    _confirm.dispose();
    super.dispose();
  }

  /// Re-check the invite code shortly after the code or server changes.
  void _scheduleCheck() {
    _debounce?.cancel();
    final code = _code.text.trim();
    if (code.isEmpty) {
      setState(() => _codeState = _CodeState.empty);
      return;
    }
    setState(() => _codeState = _CodeState.checking);
    _debounce = Timer(const Duration(milliseconds: 500), () async {
      final seq = ++_checkSeq;
      final ok = await Api.checkInvite(_server.text, code);
      if (!mounted || seq != _checkSeq) return;
      setState(() => _codeState = ok == null
          ? _CodeState.unknown
          : ok
              ? _CodeState.valid
              : _CodeState.invalid);
    });
  }

  String? _validate() {
    if (_server.text.trim().replaceAll(RegExp(r'^https?://'), '').isEmpty) {
      return 'Enter your server URL';
    }
    if (_code.text.trim().isEmpty) return 'Enter your invite code';
    if (_codeState == _CodeState.invalid) return 'That invite code is not valid';
    if (!_userPattern.hasMatch(_user.text.trim())) {
      return 'Username must be 3 to 32 characters: letters, numbers, _ . or -';
    }
    if (_pass.text.length < 10) return 'Password must be at least 10 characters';
    if (_pass.text != _confirm.text) return "Passwords don't match";
    return null;
  }

  Future<void> _submit() async {
    final problem = _validate();
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    final appState = context.read<AppState>();
    final nav = Navigator.of(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    final server = _server.text.trim();
    final username = _user.text.trim();
    try {
      // Registering signs straight in with the new account's session (liked
      // songs, media token, Android Auto all set up like a login).
      await appState.register(server, _code.text, username, _pass.text);
      nav.popUntil((r) => r.isFirst);
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.toString();
        });
      }
    }
  }

  Widget? _codeSuffix() => switch (_codeState) {
        _CodeState.empty => null,
        _CodeState.checking => const Padding(
            padding: EdgeInsets.all(14),
            child: SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
          ),
        _CodeState.valid => const Icon(Icons.check_circle, color: kAccent, size: 20),
        _CodeState.invalid => const Icon(Icons.error_outline, color: Colors.redAccent, size: 20),
        _CodeState.unknown => const Tooltip(
            message: "Couldn't check the code. Is the server URL right?",
            child: Icon(Icons.help_outline, color: kMuted, size: 20),
          ),
      };

  String? _codeHelper() => switch (_codeState) {
        _CodeState.valid => 'Invite code is valid',
        _CodeState.invalid => 'Invalid, expired or already used',
        _CodeState.unknown => "Couldn't reach the server to check this code",
        _ => null,
      };

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(backgroundColor: Colors.transparent),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 380),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(28),
                child: AutofillGroup(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      const Center(
                        child: Text('Create your account',
                            style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
                      ),
                      const SizedBox(height: 4),
                      const Center(
                        child: Text('You need an invite code from the server admin',
                            textAlign: TextAlign.center, style: TextStyle(color: kMuted)),
                      ),
                      const SizedBox(height: 22),
                      if (_error != null)
                        Container(
                          margin: const EdgeInsets.only(bottom: 16),
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: Colors.red.withValues(alpha: 0.12),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(_error!, style: const TextStyle(color: Colors.redAccent)),
                        ),
                      TextField(
                        controller: _server,
                        keyboardType: TextInputType.url,
                        onChanged: (_) => _scheduleCheck(),
                        decoration: const InputDecoration(
                          labelText: 'Server URL',
                          hintText: 'https://music.example.com',
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _code,
                        textCapitalization: TextCapitalization.characters,
                        onChanged: (_) => _scheduleCheck(),
                        decoration: InputDecoration(
                          labelText: 'Invite code',
                          suffixIcon: _codeSuffix(),
                          helperText: _codeHelper(),
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _user,
                        autofillHints: const [AutofillHints.newUsername],
                        decoration: const InputDecoration(
                          labelText: 'Username',
                          helperText: '3 to 32 letters, numbers, _ . or -',
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _pass,
                        obscureText: true,
                        autofillHints: const [AutofillHints.newPassword],
                        decoration: const InputDecoration(
                          labelText: 'Password',
                          helperText: 'At least 10 characters',
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _confirm,
                        obscureText: true,
                        onSubmitted: (_) => _submit(),
                        decoration: const InputDecoration(labelText: 'Confirm password'),
                      ),
                      const SizedBox(height: 20),
                      FilledButton(
                        onPressed: _busy ? null : _submit,
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 6),
                          child: Text(_busy ? 'Creating account…' : 'Create account'),
                        ),
                      ),
                      const SizedBox(height: 8),
                      TextButton(
                        onPressed: _busy ? null : () => Navigator.of(context).pop(),
                        child: const Text('I already have an account'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

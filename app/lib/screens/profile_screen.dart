import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../api.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../theme.dart';
import '../widgets/friends_panel.dart';

/// Profile: the signed-in user, change password, sign out, and (on mobile)
/// friend activity. Used as the mobile Profile tab and the desktop profile page.
class ProfileScreen extends StatelessWidget {
  final bool showFriends;
  const ProfileScreen({super.key, this.showFriends = true});

  @override
  Widget build(BuildContext context) {
    final user = context.watch<AppState>().user;
    final initial = (user?.username.isNotEmpty ?? false) ? user!.username[0].toUpperCase() : '?';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 24),
        Center(
          child: Container(
            width: 88,
            height: 88,
            decoration: const BoxDecoration(
              gradient: LinearGradient(colors: [kAccent, kAccent2]),
              shape: BoxShape.circle,
            ),
            child: Center(
              child: Text(initial,
                  style: const TextStyle(
                      fontSize: 36, fontWeight: FontWeight.bold, color: kAccentInk)),
            ),
          ),
        ),
        const SizedBox(height: 14),
        Center(
          child: Text(user?.username ?? '',
              style: const TextStyle(fontSize: 21, fontWeight: FontWeight.bold)),
        ),
        Center(child: Text(user?.role ?? '', style: const TextStyle(color: kMuted, fontSize: 13))),
        const SizedBox(height: 20),
        const Divider(height: 1),
        ListTile(
          leading: const Icon(LucideIcons.settings, size: 20),
          title: const Text('Change password'),
          onTap: () => _changePassword(context),
        ),
        const Divider(height: 1),
        ListTile(
          leading: const Icon(LucideIcons.logOut, size: 20),
          title: const Text('Sign out'),
          onTap: () => context.read<AppState>().logout(),
        ),
        const Divider(height: 1),
        if (showFriends) ...[
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Text('Friend activity',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          ),
          const Expanded(child: FriendsList()),
        ],
      ],
    );
  }

  void _changePassword(BuildContext context) {
    final current = TextEditingController();
    final next = TextEditingController();
    final api = context.read<Api>();
    showDialog(
      context: context,
      builder: (ctx) {
        String? error;
        bool busy = false;
        return StatefulBuilder(
          builder: (ctx, setLocal) => AlertDialog(
            backgroundColor: kPanel,
            title: const Text('Change password'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: current,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'Current password'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: next,
                  obscureText: true,
                  decoration: const InputDecoration(labelText: 'New password (min 6)'),
                ),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text(error!,
                        style: const TextStyle(color: Color(0xFFEF4444), fontSize: 13)),
                  ),
              ],
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
              TextButton(
                onPressed: busy
                    ? null
                    : () async {
                        if (next.text.length < 6) {
                          setLocal(() => error = 'New password must be at least 6 characters');
                          return;
                        }
                        setLocal(() {
                          busy = true;
                          error = null;
                        });
                        try {
                          await api.changePassword(current.text, next.text);
                          if (ctx.mounted) Navigator.pop(ctx);
                          if (context.mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text('Password changed')),
                            );
                          }
                        } catch (e) {
                          setLocal(() {
                            busy = false;
                            error = e.toString().replaceFirst('Exception: ', '');
                          });
                        }
                      },
                child: Text(busy ? 'Saving…' : 'Save'),
              ),
            ],
          ),
        );
      },
    );
  }
}

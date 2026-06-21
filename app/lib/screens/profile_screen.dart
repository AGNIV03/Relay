import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../theme.dart';
import '../widgets/friends_panel.dart';

/// Mobile Profile tab: the signed-in user, sign-out, and friend activity.
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

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
          leading: const Icon(LucideIcons.logOut, size: 20),
          title: const Text('Sign out'),
          onTap: () => context.read<AppState>().logout(),
        ),
        const Divider(height: 1),
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 16, 16, 4),
          child: Text('Friend activity',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
        ),
        const Expanded(child: FriendsList()),
      ],
    );
  }
}

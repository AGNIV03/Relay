import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../app_icons.dart';
import '../app_state.dart';
import '../theme.dart';

/// Mobile Profile tab. Shows the signed-in user and the sign-out action.
/// (More to come later.)
class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final user = context.watch<AppState>().user;
    final initial = (user?.username.isNotEmpty ?? false) ? user!.username[0].toUpperCase() : '?';
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 28, 16, 24),
      children: [
        Center(
          child: Container(
            width: 96,
            height: 96,
            decoration: const BoxDecoration(
              gradient: LinearGradient(colors: [kAccent, kAccent2]),
              shape: BoxShape.circle,
            ),
            child: Center(
              child: Text(initial,
                  style: const TextStyle(
                      fontSize: 40, fontWeight: FontWeight.bold, color: kAccentInk)),
            ),
          ),
        ),
        const SizedBox(height: 16),
        Center(
          child: Text(user?.username ?? '',
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
        ),
        const SizedBox(height: 2),
        Center(child: Text(user?.role ?? '', style: const TextStyle(color: kMuted, fontSize: 13))),
        const SizedBox(height: 28),
        const Divider(height: 1),
        ListTile(
          leading: const Icon(LucideIcons.logOut, size: 20),
          title: const Text('Sign out'),
          onTap: () => context.read<AppState>().logout(),
        ),
        const Divider(height: 1),
      ],
    );
  }
}

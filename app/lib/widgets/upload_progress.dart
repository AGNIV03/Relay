import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import '../api.dart';
import '../app_icons.dart';
import '../feature_models.dart';
import '../theme.dart';

bool get _isDesktop => !kIsWeb && (Platform.isWindows || Platform.isLinux || Platform.isMacOS);

/// A running (or finished) batch upload: per-file byte progress and outcomes.
/// Lives independently of the sheet that shows it, so closing the sheet never
/// cancels the upload; reopening it shows the live state.
class UploadJob extends ChangeNotifier {
  final List<String> paths;
  final Map<String, double> progress = {}; // path -> 0..1
  final Map<String, UploadFileResult> results = {};
  bool running = false;
  Map<String, dynamic>? summary;
  DateTime _lastNotify = DateTime.fromMillisecondsSinceEpoch(0);

  UploadJob(this.paths);

  int get doneCount => results.length;

  static String nameOf(String path) => path.split(RegExp(r'[\\/]')).last;

  Future<Map<String, dynamic>> run(Api api) async {
    running = true;
    notifyListeners();
    try {
      final r = await api.uploadManyTracks(
        paths,
        onFileProgress: (p, sent, total) {
          progress[p] = total <= 0 ? 0 : sent / total;
          // Progress fires per 64KB; repaint at most ~10 times a second.
          final now = DateTime.now();
          if (now.difference(_lastNotify).inMilliseconds > 100) {
            _lastNotify = now;
            notifyListeners();
          }
        },
        onFileDone: (p, res) {
          progress[p] = 1;
          results[p] = res;
          notifyListeners();
        },
      );
      summary = r;
      return r;
    } finally {
      running = false;
      notifyListeners();
    }
  }
}

/// Show the progress for [job]: a bottom sheet on mobile, a dialog on desktop.
Future<void> showUploadProgress(BuildContext context, UploadJob job) {
  if (_isDesktop) {
    return showDialog(
      context: context,
      builder: (ctx) => Dialog(
        backgroundColor: kPanel,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560, maxHeight: 560),
          child: UploadProgressPanel(job: job),
        ),
      ),
    );
  }
  return showModalBottomSheet(
    context: context,
    backgroundColor: kPanel,
    isScrollControlled: true,
    builder: (ctx) => SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.75),
        child: UploadProgressPanel(job: job),
      ),
    ),
  );
}

/// Per-file list with a bar each, then the final status (added / duplicate /
/// rejected with the reason).
class UploadProgressPanel extends StatelessWidget {
  final UploadJob job;
  const UploadProgressPanel({super.key, required this.job});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: job,
      builder: (context, _) {
        final total = job.paths.length;
        final added = job.results.values.where((r) => r.status == UploadStatus.added).length;
        final dupes = job.results.values.where((r) => r.status == UploadStatus.duplicate).length;
        final bad = job.doneCount - added - dupes;
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 8, 4),
              child: Row(children: [
                Expanded(
                  child: Text(
                    job.running
                        ? 'Uploading ${job.doneCount} of $total'
                        : 'Upload finished',
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold),
                  ),
                ),
                IconButton(
                  tooltip: job.running ? 'Hide (keeps uploading)' : 'Close',
                  icon: const Icon(LucideIcons.x, size: 18),
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
              child: Text(
                [
                  '$added added',
                  if (dupes > 0) '$dupes already in library',
                  if (bad > 0) '$bad rejected',
                ].join(' · '),
                style: const TextStyle(color: kMuted, fontSize: 13),
              ),
            ),
            if (job.running)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                child: LinearProgressIndicator(
                  value: total == 0
                      ? null
                      : job.paths.fold<double>(0, (a, p) => a + (job.progress[p] ?? 0)) / total,
                  backgroundColor: kBorder,
                ),
              ),
            const Divider(height: 1),
            Flexible(
              child: ListView.builder(
                shrinkWrap: true,
                padding: const EdgeInsets.symmetric(vertical: 6),
                itemCount: total,
                itemBuilder: (_, i) => _FileRow(
                  name: UploadJob.nameOf(job.paths[i]),
                  progress: job.progress[job.paths[i]],
                  result: job.results[job.paths[i]],
                ),
              ),
            ),
          ],
        );
      },
    );
  }
}

class _FileRow extends StatelessWidget {
  final String name;
  final double? progress;
  final UploadFileResult? result;
  const _FileRow({required this.name, this.progress, this.result});

  @override
  Widget build(BuildContext context) {
    final r = result;
    final (IconData icon, Color color, String label) = switch (r?.status) {
      null => (LucideIcons.upload, kMuted, progress == null ? 'Waiting' : '${((progress ?? 0) * 100).round()}%'),
      UploadStatus.added => (LucideIcons.checkCircle, kAccent, 'Added'),
      UploadStatus.duplicate => (Icons.content_copy, kMuted, 'Already in library'),
      UploadStatus.rejected => (Icons.error_outline, const Color(0xFFEF4444), 'Rejected'),
      UploadStatus.failed => (Icons.error_outline, const Color(0xFFEF4444), 'Failed'),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: Icon(icon, size: 18, color: color),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                  child: Text(name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w500)),
                ),
                const SizedBox(width: 8),
                Text(label, style: TextStyle(color: color, fontSize: 12)),
              ]),
              if (r == null) ...[
                const SizedBox(height: 6),
                ClipRRect(
                  borderRadius: BorderRadius.circular(2),
                  child: LinearProgressIndicator(
                    minHeight: 3,
                    value: progress ?? 0,
                    backgroundColor: kBorder,
                  ),
                ),
              ] else if (r.reason != null && r.reason!.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(r.reason!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: kMuted, fontSize: 12)),
                ),
            ]),
          ),
        ],
      ),
    );
  }
}

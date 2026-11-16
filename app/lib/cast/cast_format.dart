/// The MIME type to cast a library file as when the Default Media Receiver can
/// decode it natively, else null (send a 320k MP3 transcode instead). Formats it
/// plays go as the original file, which stays range-seekable. Mirrors
/// `nativeCastType` in web/src/lib/cast.ts.
String? nativeCastType(String? format, int? bitrate) {
  final f = (format ?? '').toLowerCase();
  final kbps = bitrate ?? 0;
  switch (f) {
    case 'mp3':
      return 'audio/mpeg';
    case 'aac':
      return 'audio/aac';
    case 'm4a' || 'mp4':
      return kbps > 0 && kbps <= 512 ? 'audio/mp4' : null; // AAC; ALAC runs far higher
    case 'ogg' || 'oga' || 'opus':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    case 'flac':
      return kbps > 0 && kbps <= 3300 ? 'audio/flac' : null; // up to ~96 kHz / 24-bit
    case 'wav':
      return kbps > 0 && kbps <= 4608 ? 'audio/wav' : null;
  }
  return null;
}

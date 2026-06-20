package site.agniv.stream

// just_audio_background / audio_service requires the host Activity to extend
// AudioServiceActivity (not the default FlutterActivity) so it provides the
// correct FlutterEngine. Using FlutterActivity crashes JustAudioBackground.init().
import com.ryanheise.audioservice.AudioServiceActivity

class MainActivity : AudioServiceActivity()

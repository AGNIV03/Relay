package site.agniv.relay

import android.app.SearchManager
import android.content.ComponentName
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Bundle
import android.provider.MediaStore
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.session.MediaControllerCompat
import android.util.Log
import androidx.core.view.WindowCompat
import com.ryanheise.audioservice.AudioService
import com.ryanheise.audioservice.AudioServiceActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// just_audio_background / audio_service requires the host Activity to extend
// AudioServiceActivity (not the default FlutterActivity) so it provides the
// correct FlutterEngine. Using FlutterActivity crashes JustAudioBackground.init().
class MainActivity : AudioServiceActivity() {
    private var browser: MediaBrowserCompat? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    // "relay/net": a Wi-Fi multicast lock for Chromecast discovery. Most devices
    // filter incoming multicast (mDNS answers) unless an app holds one; the cast
    // picker acquires it only while scanning (lib/cast/cast_discovery.dart).
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "relay/net")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "multicastLock" -> {
                        try {
                            val lock = multicastLock ?: (applicationContext
                                .getSystemService(WIFI_SERVICE) as WifiManager)
                                .createMulticastLock("relay-cast")
                                .apply { setReferenceCounted(false) }
                            multicastLock = lock
                            if (!lock.isHeld) lock.acquire()
                            result.success(true)
                        } catch (e: Exception) {
                            result.error("multicast", e.message, null)
                        }
                    }
                    "multicastUnlock" -> {
                        multicastLock?.let { if (it.isHeld) it.release() }
                        result.success(true)
                    }
                    else -> result.notImplemented()
                }
            }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Edge-to-edge on every Android version, not just 15+ (where targetSdk 35+
        // forces it): draw behind the status and navigation bars, which the theme
        // makes transparent. Flutter's Scaffold / SafeArea already pad for the
        // system insets, so the layout matches what Android 15+ users see.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        super.onCreate(savedInstanceState)
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    // "Hey Google, play <query> on Relay" launches us with MEDIA_PLAY_FROM_SEARCH
    // and the spoken text in SearchManager.QUERY. We connect to our own
    // MediaBrowserService and issue playFromSearch on its session, which the Dart
    // handler resolves (search -> play top result) — identical to the in-car
    // "play X" voice path. An empty query ("play some music on Relay") is valid
    // and means "resume/play something".
    private fun handleIntent(intent: Intent?) {
        if (intent?.action != MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH) return
        // Some senders use ACTION_SEARCH's QUERY; MEDIA_PLAY_FROM_SEARCH uses the
        // same extra key. Fall back to intent's own query extra just in case.
        val query = intent.getStringExtra(SearchManager.QUERY) ?: ""
        val extras = intent.extras ?: Bundle()
        Log.i("RelayAA", "MEDIA_PLAY_FROM_SEARCH launch query='$query'")
        playFromSearch(query, extras)
    }

    private fun playFromSearch(query: String, extras: Bundle) {
        // Reuse any existing connection; otherwise connect fresh.
        val existing = browser
        if (existing != null && existing.isConnected) {
            issue(existing, query, extras)
            return
        }
        val b = MediaBrowserCompat(
            this,
            ComponentName(this, AudioService::class.java),
            object : MediaBrowserCompat.ConnectionCallback() {
                override fun onConnected() {
                    val br = browser ?: return
                    issue(br, query, extras)
                }
            },
            null,
        )
        browser = b
        b.connect()
    }

    private fun issue(b: MediaBrowserCompat, query: String, extras: Bundle) {
        try {
            val controller = MediaControllerCompat(this, b.sessionToken)
            controller.transportControls.playFromSearch(query, extras)
            Log.i("RelayAA", "playFromSearch dispatched to session")
        } catch (e: Exception) {
            Log.e("RelayAA", "playFromSearch dispatch failed: $e")
        }
    }

    override fun onDestroy() {
        multicastLock?.let { if (it.isHeld) it.release() }
        multicastLock = null
        browser?.disconnect()
        browser = null
        super.onDestroy()
    }
}

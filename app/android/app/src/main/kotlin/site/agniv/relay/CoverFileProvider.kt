package site.agniv.relay

import androidx.core.content.FileProvider

// Own subclass (rather than androidx's FileProvider directly) so the manifest
// entry can never collide with another library's FileProvider declaration.
// Serves downloaded cover art to Android Auto; see res/xml/cover_paths.xml.
class CoverFileProvider : FileProvider()

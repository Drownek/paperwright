package me.drownek.plugwright

import org.gradle.api.logging.Logger
import java.util.Properties

internal object Banner {
    fun pluginVersion(): String {
        return try {
            Banner::class.java.getResourceAsStream("/plugwright-version.properties")?.use { stream ->
                val props = Properties()
                props.load(stream)
                props.getProperty("version", "unknown")
            } ?: "unknown"
        } catch (_: Exception) {
            "unknown"
        }
    }

    private fun ansiGradient(text: String, from: Triple<Int, Int, Int>, to: Triple<Int, Int, Int>): String {
        val sb = StringBuilder()
        val n = text.length
        for (i in 0 until n) {
            val t = if (n <= 1) 0.0 else i.toDouble() / (n - 1)
            val r = (from.first + (to.first - from.first) * t).toInt()
            val g = (from.second + (to.second - from.second) * t).toInt()
            val b = (from.third + (to.third - from.third) * t).toInt()
            sb.append("\u001B[38;2;$r;$g;${b}m").append(text[i])
        }
        sb.append("\u001B[0m")
        return sb.toString()
    }

    fun print(logger: Logger) {
        val version = pluginVersion()
        val title = ansiGradient("plugwright", Triple(0x5e, 0xea, 0xd4), Triple(0xc0, 0x82, 0xff))
        val dim = "\u001B[2m"
        val reset = "\u001B[0m"
        val bold = "\u001B[1m"
        logger.lifecycle("")
        logger.lifecycle("  $bold$title$reset  ${dim}v$version  -  end-to-end testing for paper plugins$reset")
        logger.lifecycle("  $dim${"-".repeat(60)}$reset")
        logger.lifecycle("")
    }
}

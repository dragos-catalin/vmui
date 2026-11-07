package ro.vatra.core.push

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Hub ↔ app end-to-end encryption of relay pushes (docs/product/cloud/CONTRACT.md):
 * `e` = b64url(12-byte nonce ‖ ciphertext ‖ 16-byte tag), AES-256-GCM, aad = UTF-8 card id.
 * The relay, Apple and Google never see the card text.
 */
object PushCrypto {
    private const val NONCE = 12
    private const val TAG_BITS = 128

    /** The per-device key the hub returned once at registration (`e2eKey`, base64url 32 bytes). */
    fun decodeKey(b64url: String): ByteArray {
        val k = Base64.getUrlDecoder().decode(b64url.trim())
        require(k.size == 32) { "e2eKey must be 32 bytes" }
        return k
    }

    /** Throws when the key, the card id or any byte of [e] is wrong: the GCM tag covers all three. */
    fun open(e2eKey: ByteArray, cardId: String, e: String): ByteArray {
        require(e2eKey.size == 32) { "e2eKey must be 32 bytes" }
        val raw = Base64.getUrlDecoder().decode(e.trim())
        require(raw.size >= NONCE + TAG_BITS / 8) { "ciphertext too short" }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(e2eKey, "AES"), GCMParameterSpec(TAG_BITS, raw, 0, NONCE))
        c.updateAAD(cardId.toByteArray(Charsets.UTF_8))
        return c.doFinal(raw, NONCE, raw.size - NONCE)
    }
}

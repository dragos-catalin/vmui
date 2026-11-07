package ro.vatra.core.hub

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val Context.hubStore: DataStore<Preferences> by preferencesDataStore(name = "vatra_hubs")

/**
 * Paired hubs, encrypted at rest with an Android Keystore AES-GCM key: the device tokens never
 * sit in plain prefs, and a backup of the data dir is useless off this phone (backup is off too).
 * One blob decrypted once per read — no per-key crypto on the main thread (codai lesson, 2026-10-16).
 */
class HubStore(context: Context) {
    private val store = context.applicationContext.hubStore
    private val key = stringPreferencesKey("hubs.v1")

    val hubs: Flow<HubList> = store.data.map { HubList.decode(it[key]?.let(::open)) }

    suspend fun current(): HubList = hubs.first()

    suspend fun update(f: (HubList) -> HubList): HubList {
        var out = HubList()
        store.edit { p ->
            out = f(HubList.decode(p[key]?.let(::open)))
            p[key] = seal(out.encode())
        }
        return out
    }

    private fun secret(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun seal(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, secret()) }
        val out = c.iv + c.doFinal(plain.toByteArray())
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    /** Null when the key is gone (app data restored elsewhere): the phone simply has to pair again. */
    private fun open(sealed: String): String? = runCatching {
        val raw = Base64.decode(sealed, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, raw, 0, 12)) }
        String(c.doFinal(raw, 12, raw.size - 12))
    }.getOrNull()

    private companion object {
        const val ALIAS = "vatra-hubs"
    }
}

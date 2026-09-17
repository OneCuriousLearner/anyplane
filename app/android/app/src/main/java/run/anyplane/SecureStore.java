package run.anyplane;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * token/cookie 的 Keystore 包装存储：AES/GCM 密钥由 AndroidKeyStore 托管（不出 TEE/SE），
 * SharedPreferences 里只落 Base64(iv + 密文)。读取带明文迁移：解密失败按历史明文处理
 * 并就地重加密（老版本直写的明文无缝升级）。serverUrl 非敏感，不走这里。
 */
final class SecureStore {

    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "anyplane_bridge_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int GCM_IV_BYTES = 12;

    private SecureStore() {}

    static void putSecret(SharedPreferences p, String key, String value) {
        String stored = value == null || value.isEmpty() ? "" : encrypt(value);
        p.edit().putString(key, stored == null ? "" : stored).apply();
    }

    static String getSecret(SharedPreferences p, String key) {
        String stored = p.getString(key, "");
        if (stored == null || stored.isEmpty()) return "";
        String plain = decrypt(stored);
        if (plain != null) return plain;
        // 明文迁移期（含 adb 预置/老版本直写）：按明文返回并就地重加密
        putSecret(p, key, stored);
        return stored;
    }

    private static SecretKey ensureKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        kg.init(
            new KeyGenParameterSpec.Builder(
                ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return kg.generateKey();
    }

    private static String encrypt(String value) {
        try {
            Cipher c = Cipher.getInstance(TRANSFORMATION);
            c.init(Cipher.ENCRYPT_MODE, ensureKey());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return Base64.encodeToString(out, Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    private static String decrypt(String stored) {
        try {
            byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
            if (blob.length <= GCM_IV_BYTES) return null;
            Cipher c = Cipher.getInstance(TRANSFORMATION);
            c.init(Cipher.DECRYPT_MODE, ensureKey(), new GCMParameterSpec(GCM_TAG_BITS, blob, 0, GCM_IV_BYTES));
            return new String(c.doFinal(blob, GCM_IV_BYTES, blob.length - GCM_IV_BYTES), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}

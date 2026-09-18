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
        if (value == null || value.isEmpty()) {
            p.edit().putString(key, "").apply();
            return;
        }
        String stored = encrypt(value);
        // 加密失败（Keystore 瞬态故障）宁可不动旧值，也绝不把 "" 盖到有效凭据上（评审发现）
        if (stored == null) return;
        p.edit().putString(key, stored).apply();
    }

    static String getSecret(SharedPreferences p, String key) {
        String stored = p.getString(key, "");
        if (stored == null || stored.isEmpty()) return "";
        // 版本前缀定界（评审发现：靠形态猜密文不可靠——hex 明文 token 会被误判成密文清掉）：
        // "v1:" = 本代加密格式；无前缀 = 历史明文（老版本/adb 预置），就地重加密。
        if (stored.startsWith("v1:")) {
            String plain = decrypt(stored.substring(3));
            // 密钥丢失（备份迁移不带 AndroidKeyStore 密钥）：返回空逼重配——
            // 再加密只是把垃圾封存成「合法 token」，所有 Bearer 调用 401 且无迹可循
            return plain == null ? "" : plain;
        }
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
            return "v1:" + Base64.encodeToString(out, Base64.NO_WRAP);
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

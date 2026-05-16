/*
 * SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO., LTD
 * SPDX-License-Identifier: LicenseRef-Espressif-Modified-MIT
 *
 * See LICENSE file for details.
 */

#include "dtls_common.h"

// Chip-side cert gen has been removed; the dashboard supplies a per-session
// ECDSA P-256 cert+key over BLE pre-handshake. See the v5 sibling
// dtls_srtp.c for the full notes; this is the IDF v6 / PSA path. We only
// parse here — mbedtls_x509write_crt_* + psa key gen are gc-stripped.

static int dtls_srtp_try_gen_cert(dtls_srtp_t *dtls_srtp)
{
    int ret = 0;
    mbedtls_x509_crt_init(&dtls_srtp->cert);
    mbedtls_pk_init(&dtls_srtp->pkey);
    dtls_srtp->psa_key_id = MBEDTLS_SVC_KEY_ID_INIT;
    mbedtls_ctr_drbg_init(&dtls_srtp->ctr_drbg);
    const char *pers = "dtls_srtp";
    ret = mbedtls_ctr_drbg_seed(&dtls_srtp->ctr_drbg, dtls_srtp_entropy_func, NULL, (const unsigned char *)pers,
                                strlen(pers));
    if (ret != 0) {
        ESP_LOGE(TAG, "mbedtls_ctr_drbg_seed failed, ret=%d", ret);
        return ret;
    }
    if (!s_cached_cert_ready) {
        ESP_LOGE(TAG, "no cert supplied — dashboard must push cert+key (opcode 0x07/0x08/0x09) before opening WebRTC");
        return -1;
    }
    size_t cert_pem_len = strlen((const char *)s_cached_cert_pem) + 1;
    size_t key_pem_len  = strlen((const char *)s_cached_key_pem) + 1;
    ret = mbedtls_x509_crt_parse(&dtls_srtp->cert, s_cached_cert_pem, cert_pem_len);
    if (ret == 0) {
        ret = mbedtls_pk_parse_key(&dtls_srtp->pkey, s_cached_key_pem, key_pem_len, NULL, 0);
    }
    if (ret != 0) {
        ESP_LOGE(TAG, "parse supplied cert/key failed, ret=%d", ret);
    }
    return ret;
}

int dtls_srtp_gen_cert(void)
{
    return 0;
}

dtls_srtp_t *dtls_srtp_init(dtls_srtp_cfg_t *cfg)
{
    dtls_srtp_t *dtls_srtp = (dtls_srtp_t *) media_lib_calloc(1, sizeof(dtls_srtp_t));
    if (dtls_srtp == NULL) {
        return NULL;
    }
    int ret = check_srtp(true);
    do {
        BREAK_ON_FAIL(ret);
        media_lib_mutex_create(&dtls_srtp->lock);
        dtls_srtp->role = cfg->role;
        dtls_srtp->state = DTLS_SRTP_STATE_INIT;
        dtls_srtp->ctx = cfg->ctx;
        dtls_srtp->udp_send = cfg->udp_send;
        dtls_srtp->udp_recv = cfg->udp_recv;

        mbedtls_ssl_config_init(&dtls_srtp->conf);
        mbedtls_ssl_init(&dtls_srtp->ssl);
        ret = dtls_srtp_try_gen_cert(dtls_srtp);
        BREAK_ON_FAIL(ret);

        if (dtls_srtp->role == DTLS_SRTP_ROLE_SERVER) {
            ret = mbedtls_ssl_config_defaults(&dtls_srtp->conf, MBEDTLS_SSL_IS_SERVER, MBEDTLS_SSL_TRANSPORT_DATAGRAM,
                                              MBEDTLS_SSL_PRESET_DEFAULT);
            mbedtls_ssl_cookie_init(&dtls_srtp->cookie_ctx);
            mbedtls_ssl_cookie_setup(&dtls_srtp->cookie_ctx);
            mbedtls_ssl_conf_dtls_cookies(&dtls_srtp->conf, mbedtls_ssl_cookie_write, mbedtls_ssl_cookie_check,
                                          &dtls_srtp->cookie_ctx);
        } else {
            ret = mbedtls_ssl_config_defaults(&dtls_srtp->conf, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_DATAGRAM,
                                              MBEDTLS_SSL_PRESET_DEFAULT);
        }
        BREAK_ON_FAIL(ret);
        dtls_srtp_conf_force_dtls12(&dtls_srtp->conf);
        mbedtls_ssl_conf_ca_chain(&dtls_srtp->conf, &dtls_srtp->cert, NULL);
        ret = mbedtls_ssl_conf_own_cert(&dtls_srtp->conf, &dtls_srtp->cert, &dtls_srtp->pkey);
        BREAK_ON_FAIL(ret);
        if (dtls_srtp->role == DTLS_SRTP_ROLE_CLIENT) {
            mbedtls_ssl_conf_authmode(&dtls_srtp->conf, MBEDTLS_SSL_VERIFY_OPTIONAL);
        }
        mbedtls_ssl_conf_read_timeout(&dtls_srtp->conf, 1000);
        mbedtls_ssl_conf_handshake_timeout(&dtls_srtp->conf, 1000, 6000);
        mbedtls_ssl_conf_dtls_anti_replay(&dtls_srtp->conf, MBEDTLS_SSL_ANTI_REPLAY_DISABLED);

        dtls_srtp_x509_digest(&dtls_srtp->cert, dtls_srtp->local_fingerprint);
        ret = mbedtls_ssl_conf_dtls_srtp_protection_profiles(&dtls_srtp->conf, default_profiles);
        BREAK_ON_FAIL(ret);

        mbedtls_ssl_conf_srtp_mki_value_supported(&dtls_srtp->conf, MBEDTLS_SSL_DTLS_SRTP_MKI_UNSUPPORTED);
        ret = mbedtls_ssl_setup(&dtls_srtp->ssl, &dtls_srtp->conf);
        BREAK_ON_FAIL(ret);
        mbedtls_ssl_set_mtu(&dtls_srtp->ssl, DTLS_MTU_SIZE);
        return dtls_srtp;
    } while (0);
    dtls_srtp_deinit(dtls_srtp);
    return NULL;
}

void dtls_srtp_deinit(dtls_srtp_t *dtls_srtp)
{
    if (dtls_srtp->state == DTLS_SRTP_STATE_NONE) {
        return;
    }
    mbedtls_ssl_free(&dtls_srtp->ssl);
    mbedtls_ssl_config_free(&dtls_srtp->conf);

    mbedtls_x509_crt_free(&dtls_srtp->cert);
    mbedtls_pk_free(&dtls_srtp->pkey);
    if (dtls_srtp->psa_key_id != MBEDTLS_SVC_KEY_ID_INIT) {
        psa_destroy_key(dtls_srtp->psa_key_id);
        dtls_srtp->psa_key_id = MBEDTLS_SVC_KEY_ID_INIT;
    }
    mbedtls_ctr_drbg_free(&dtls_srtp->ctr_drbg);

    if (dtls_srtp->role == DTLS_SRTP_ROLE_SERVER) {
        mbedtls_ssl_cookie_free(&dtls_srtp->cookie_ctx);
    }
    if (dtls_srtp->srtp_in) {
        srtp_dealloc(dtls_srtp->srtp_in);
        dtls_srtp->srtp_in = NULL;
    }
    if (dtls_srtp->srtp_out) {
        srtp_dealloc(dtls_srtp->srtp_out);
        dtls_srtp->srtp_out = NULL;
    }
    if (dtls_srtp->lock) {
        media_lib_mutex_destroy(dtls_srtp->lock);
    }
    check_srtp(false);
    dtls_srtp->state = DTLS_SRTP_STATE_NONE;
}

void dtls_srtp_reset_session(dtls_srtp_t *dtls_srtp, dtls_srtp_role_t role)
{
    if (dtls_srtp->state == DTLS_SRTP_STATE_CONNECTED) {
        srtp_dealloc(dtls_srtp->srtp_in);
        dtls_srtp->srtp_in = NULL;
        srtp_dealloc(dtls_srtp->srtp_out);
        dtls_srtp->srtp_out = NULL;
        mbedtls_ssl_session_reset(&dtls_srtp->ssl);
    }
    if (role != dtls_srtp->role) {
        if (dtls_srtp->role == DTLS_SRTP_ROLE_SERVER) {
            mbedtls_ssl_cookie_free(&dtls_srtp->cookie_ctx);
        }
        if (role == DTLS_SRTP_ROLE_SERVER) {
            mbedtls_ssl_config_defaults(&dtls_srtp->conf, MBEDTLS_SSL_IS_SERVER, MBEDTLS_SSL_TRANSPORT_DATAGRAM,
                                        MBEDTLS_SSL_PRESET_DEFAULT);
            dtls_srtp_conf_force_dtls12(&dtls_srtp->conf);

            mbedtls_ssl_cookie_init(&dtls_srtp->cookie_ctx);
            mbedtls_ssl_cookie_setup(&dtls_srtp->cookie_ctx);
            mbedtls_ssl_conf_dtls_cookies(&dtls_srtp->conf, mbedtls_ssl_cookie_write, mbedtls_ssl_cookie_check,
                                          &dtls_srtp->cookie_ctx);
        } else {
            mbedtls_ssl_config_defaults(&dtls_srtp->conf, MBEDTLS_SSL_IS_CLIENT, MBEDTLS_SSL_TRANSPORT_DATAGRAM,
                                        MBEDTLS_SSL_PRESET_DEFAULT);
            dtls_srtp_conf_force_dtls12(&dtls_srtp->conf);
            mbedtls_ssl_conf_authmode(&dtls_srtp->conf, MBEDTLS_SSL_VERIFY_OPTIONAL);
        }
        mbedtls_ssl_conf_ca_chain(&dtls_srtp->conf, &dtls_srtp->cert, NULL);
        mbedtls_ssl_conf_own_cert(&dtls_srtp->conf, &dtls_srtp->cert, &dtls_srtp->pkey);
        mbedtls_ssl_conf_read_timeout(&dtls_srtp->conf, 1000);
        mbedtls_ssl_conf_handshake_timeout(&dtls_srtp->conf, 1000, 6000);
        mbedtls_ssl_conf_dtls_srtp_protection_profiles(&dtls_srtp->conf, default_profiles);
        mbedtls_ssl_conf_srtp_mki_value_supported(&dtls_srtp->conf, MBEDTLS_SSL_DTLS_SRTP_MKI_UNSUPPORTED);
        mbedtls_ssl_conf_dtls_anti_replay(&dtls_srtp->conf, MBEDTLS_SSL_ANTI_REPLAY_DISABLED);
        mbedtls_ssl_setup(&dtls_srtp->ssl, &dtls_srtp->conf);
        mbedtls_ssl_set_mtu(&dtls_srtp->ssl, DTLS_MTU_SIZE);
        dtls_srtp->role = role;
    }
    dtls_srtp->state = DTLS_SRTP_STATE_INIT;
}

void utils_get_hmac_sha1(const char *input, size_t input_len, const char *key, size_t key_len, unsigned char *output)
{
    const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_SHA1);
    if (md == NULL || output == NULL || input == NULL || key == NULL) {
        return;
    }
    if (mbedtls_md_hmac(md, (const unsigned char *)key, key_len, (const unsigned char *)input, input_len, output)
        != 0) {
        memset(output, 0, 20);
    }
}

void utils_get_md5(const char *input, size_t input_len, unsigned char *output)
{
    const mbedtls_md_info_t *md = mbedtls_md_info_from_type(MBEDTLS_MD_MD5);
    if (md == NULL || output == NULL || input == NULL) {
        return;
    }
    if (mbedtls_md(md, (const unsigned char *)input, input_len, output) != 0) {
        memset(output, 0, 16);
    }
}

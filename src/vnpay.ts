import timezone from 'moment-timezone';
import {
    VNPAY_GATEWAY_SANDBOX_HOST,
    PAYMENT_ENDPOINT,
    VNP_DEFAULT_COMMAND,
    VNP_VERSION,
    QUERY_DR_REFUND_ENDPOINT,
    QUERY_DR_RESPONSE_MAP,
    REFUND_RESPONSE_MAP,
    GET_BANK_LIST_ENDPOINT,
    ProductCode,
} from './constants';
import { HashAlgorithm, VnpCurrCode, VnpLocale } from './enums';
import {
    dateFormat,
    getResponseByStatusCode,
    hash,
    isValidVnpayDateFormat,
    resolveUrlString,
} from './utils/common';
import {
    VNPayConfig,
    BuildPaymentUrl,
    ReturnQueryFromVNPay,
    VerifyReturnUrl,
    VerifyIpnCall,
} from './types';
import { QueryDr, BodyRequestQueryDr, QueryDrResponseFromVNPay } from './types/query-dr.type';
import { Refund, RefundResponse } from './types/refund.type';
import { Bank } from './types/bank.type';

type GlobalConfig = Omit<VNPayConfig, 'testMode'> & {
    vnpayHost: string;
    vnp_Locale: VnpLocale;
    vnp_CurrCode: string;
    vnp_Command: string;
    vnp_OrderType: string;
};

/**
 * Lớp hỗ trợ thanh toán qua VNPay
 * @en VNPay class to support VNPay payment
 * @see https://sandbox.vnpayment.vn/apis/docs/huong-dan-tich-hop/
 *
 * @example
 * import { VNPay } from 'vnpay';
 *
 * const vnpay = new VNPay({
 *     api_Host: 'https://sandbox.vnpayment.vn',
 *     tmnCode: 'TMNCODE',
 *     secureSecret: 'SERCRET',
 *     testMode: true, // optional
 *     hashAlgorithm: 'SHA512', // optional
 *     paymentEndpoint: 'paymentv2/vpcpay.html', // optional
 * });
 *
 * const tnx = '12345678'; // Generate your own transaction code
 * const urlString = vnpay.buildPaymentUrl({
 *     vnp_Amount: 100000,
 *      vnp_IpAddr: '192.168.0.1',
 *      vnp_ReturnUrl: 'http://localhost:8888/order/vnpay_return',
 *      vnp_TxnRef: tnx,
 *      vnp_OrderInfo: `Thanh toan cho ma GD: ${tnx}`,
 * }),
 *
 */
export class VNPay {
    private globalDefaultConfig: GlobalConfig;
    private HASH_ALGORITHM: HashAlgorithm = 'SHA512';
    private BUFFER_ENCODE: BufferEncoding = 'utf-8';

    public constructor({
        vnpayHost = VNPAY_GATEWAY_SANDBOX_HOST,
        vnp_Version = VNP_VERSION,
        vnp_CurrCode = VnpCurrCode.VND,
        vnp_Locale = VnpLocale.VN,
        testMode = false,
        paymentEndpoint = PAYMENT_ENDPOINT,
        ...config
    }: VNPayConfig) {
        if (testMode) {
            vnpayHost = VNPAY_GATEWAY_SANDBOX_HOST;
        }

        if (config?.hashAlgorithm) {
            this.HASH_ALGORITHM = config.hashAlgorithm;
        }

        this.globalDefaultConfig = {
            vnpayHost,
            vnp_Version,
            vnp_CurrCode,
            vnp_Locale,
            vnp_OrderType: ProductCode.Other,
            vnp_Command: VNP_DEFAULT_COMMAND,
            ...config,
        };
    }

    /**
     * Lấy cấu hình mặc định của VNPay
     * @en Get default config of VNPay
     */
    public get defaultConfig() {
        return {
            vnp_TmnCode: this.globalDefaultConfig.tmnCode,
            vnp_Version: this.globalDefaultConfig.vnp_Version,
            vnp_CurrCode: this.globalDefaultConfig.vnp_CurrCode,
            vnp_Locale: this.globalDefaultConfig.vnp_Locale,
            vnp_Command: this.globalDefaultConfig.vnp_Command,
            vnp_OrderType: this.globalDefaultConfig.vnp_OrderType,
        };
    }

    public async getBankList() {
        const response = await fetch(
            resolveUrlString(
                this.globalDefaultConfig.vnpayHost ?? VNPAY_GATEWAY_SANDBOX_HOST,
                GET_BANK_LIST_ENDPOINT,
            ),
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `tmn_code=${this.globalDefaultConfig.tmnCode}`,
            },
        );
        const bankList = (await response.json()) as Bank[];
        bankList.forEach(
            (b) =>
                (b.logo_link = resolveUrlString(
                    this.globalDefaultConfig.vnpayHost ?? VNPAY_GATEWAY_SANDBOX_HOST,
                    b.logo_link.slice(1),
                )),
        );
        return bankList;
    }

    /**
     * Phương thức xây dựng, tạo thành url thanh toán của VNPay
     * @en Build the payment url
     *
     * @param {BuildPaymentUrl} data - Payload that contains the information to build the payment url
     * @returns {string} The payment url string
     * @see https://sandbox.vnpayment.vn/apis/docs/huong-dan-tich-hop/#t%E1%BA%A1o-url-thanh-to%C3%A1n
     */
    public buildPaymentUrl(data: BuildPaymentUrl): string {
        const dataToBuild = {
            ...this.defaultConfig,
            ...data,
        };

        dataToBuild.vnp_Amount = dataToBuild.vnp_Amount * 100;

        if (!isValidVnpayDateFormat(dataToBuild?.vnp_CreateDate ?? 0)) {
            const timeGMT7 = timezone(new Date()).tz('Asia/Ho_Chi_Minh').format();
            dataToBuild.vnp_CreateDate = dateFormat(new Date(timeGMT7), 'yyyyMMddHHmmss');
        }

        const redirectUrl = new URL(
            resolveUrlString(
                this.globalDefaultConfig.vnpayHost ?? VNPAY_GATEWAY_SANDBOX_HOST,
                this.globalDefaultConfig.paymentEndpoint ?? PAYMENT_ENDPOINT,
            ),
        );
        Object.entries(dataToBuild)
            .sort(([key1], [key2]) => key1.toString().localeCompare(key2.toString()))
            .forEach(([key, value]) => {
                // Skip empty value
                if (!value || value === '' || value === undefined || value === null) {
                    return;
                }

                redirectUrl.searchParams.append(key, value.toString());
            });

        const signed = hash(
            this.globalDefaultConfig.secureSecret,
            Buffer.from(redirectUrl.search.slice(1).toString(), this.BUFFER_ENCODE),
            this.HASH_ALGORITHM,
        );

        redirectUrl.searchParams.append('vnp_SecureHash', signed);

        return redirectUrl.toString();
    }

    /**
     * Phương thức xác thực tính đúng đắn của các tham số trả về từ VNPay
     * @en Method to verify the return url from VNPay
     *
     * @param {ReturnQueryFromVNPay} query - The object of data return from VNPay
     * @returns {VerifyReturnUrl} The return object
     * @see https://sandbox.vnpayment.vn/apis/docs/huong-dan-tich-hop/#code-returnurl
     */
    public verifyReturnUrl(query: ReturnQueryFromVNPay): VerifyReturnUrl {
        const secureHash = query.vnp_SecureHash;

        // Will be remove when append to URLSearchParams
        delete query.vnp_SecureHash;
        delete query.vnp_SecureHashType;

        const outputResults = {
            isVerified: true,
            isSuccess: query.vnp_ResponseCode === '00',
            message: getResponseByStatusCode(
                query.vnp_ResponseCode?.toString() ?? '',
                this.globalDefaultConfig.vnp_Locale,
            ),
        };

        const searchParams = new URLSearchParams();
        Object.entries(query)
            .sort(([key1], [key2]) => key1.toString().localeCompare(key2.toString()))
            .forEach(([key, value]) => {
                // Skip empty value
                if (value === '' || value === undefined || value === null) {
                    return;
                }

                searchParams.append(key, value.toString());
            });

        const signed = hash(
            this.globalDefaultConfig.secureSecret,
            Buffer.from(searchParams.toString(), this.BUFFER_ENCODE),
            this.HASH_ALGORITHM,
        );

        if (secureHash !== signed) {
            Object.assign(outputResults, {
                isVerified: false,
                message: 'Wrong checksum',
            });
        }

        return {
            ...query,
            ...outputResults,
            vnp_Amount: query.vnp_Amount / 100,
        };
    }

    /**
     * Phương thức xác thực tính đúng đắn của lời gọi ipn từ VNPay
     *
     * Sau khi nhận được lời gọi, hệ thống merchant cần xác thực dữ liệu nhận được từ VNPay, kiểm tra đơn hàng có hợp lệ không, kiểm tra số tiền thanh toán có đúng không.
     *
     * Sau đó phản hồi lại VNPay kết quả xác thực thông qua các `IpnResponse`
     *
     * @en Method to verify the ipn url from VNPay
     *
     * After receiving the call, the merchant system needs to verify the data received from VNPay, check if the order is valid, check if the payment amount is correct.
     *
     * Then respond to VNPay the verification result through the `IpnResponse`
     *
     * @param {ReturnQueryFromVNPay} query The object of data return from VNPay
     * @returns {VerifyIpnCall} The return object
     * @see https://sandbox.vnpayment.vn/apis/docs/huong-dan-tich-hop/#code-ipn-url
     */
    public verifyIpnCall(query: ReturnQueryFromVNPay): VerifyIpnCall {
        return this.verifyReturnUrl(query);
    }

    /**
     * Đây là API để hệ thống merchant truy vấn kết quả thanh toán của giao dịch tại hệ thống VNPAY.
     * @en This is the API for the merchant system to query the payment result of the transaction at the VNPAY system.
     *
     * @param {QueryDr} query - The data to query
     * @returns {Promise<QueryDrResponseFromVNPay>} The data return from VNPay
     * @see https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr&refund.html#truy-van-ket-qua-thanh-toan-PAY
     */
    public async queryDr(query: QueryDr): Promise<QueryDrResponseFromVNPay> {
        const command = 'querydr';
        const dataQuery = {
            vnp_Version: this.globalDefaultConfig.vnp_Version ?? VNP_VERSION,
            ...query,
        };

        const url = new URL(
            resolveUrlString(
                this.globalDefaultConfig.vnpayHost ?? VNPAY_GATEWAY_SANDBOX_HOST,
                QUERY_DR_REFUND_ENDPOINT,
            ),
        );

        const stringToCheckSum =
            `${dataQuery.vnp_RequestId}|${dataQuery.vnp_Version}|${command}` +
            `|${this.globalDefaultConfig.tmnCode}|${dataQuery.vnp_TxnRef}|${dataQuery.vnp_TransactionDate}` +
            `|${dataQuery.vnp_CreateDate}|${dataQuery.vnp_IpAddr}|${dataQuery.vnp_OrderInfo}`;

        const signed = hash(
            this.globalDefaultConfig.secureSecret,
            Buffer.from(stringToCheckSum, this.BUFFER_ENCODE),
            this.HASH_ALGORITHM,
        );

        const body: BodyRequestQueryDr = {
            ...dataQuery,
            vnp_Command: command,
            vnp_TmnCode: this.globalDefaultConfig.tmnCode,
            vnp_SecureHash: signed,
        };

        const response = await fetch(url.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const responseData = (await response.json()) as QueryDrResponseFromVNPay;

        if (
            Number(responseData.vnp_ResponseCode) >= 90 &&
            Number(responseData.vnp_ResponseCode) <= 99
        ) {
            return {
                ...responseData,
                vnp_Message: getResponseByStatusCode(
                    responseData.vnp_ResponseCode?.toString(),
                    this.globalDefaultConfig.vnp_Locale,
                    QUERY_DR_RESPONSE_MAP,
                ),
            };
        }

        let stringToCheckSumResponse =
            `${responseData.vnp_ResponseId}|${responseData.vnp_Command}|${responseData.vnp_ResponseCode}` +
            `|${responseData.vnp_Message}|${this.defaultConfig.vnp_TmnCode}|${responseData.vnp_TxnRef}` +
            `|${responseData.vnp_Amount}|${responseData.vnp_BankCode}|${responseData.vnp_PayDate}` +
            `|${responseData.vnp_TransactionNo}|${responseData.vnp_TransactionType}|${responseData.vnp_TransactionStatus}` +
            `|${responseData.vnp_OrderInfo}|${responseData.vnp_PromotionCode}|${responseData.vnp_PromotionAmount}`;
        stringToCheckSumResponse = stringToCheckSumResponse.replace(/undefined/g, '');

        const signedResponse = hash(
            this.globalDefaultConfig.secureSecret,
            Buffer.from(stringToCheckSumResponse, this.BUFFER_ENCODE),
            this.HASH_ALGORITHM,
        );

        if (signedResponse !== responseData.vnp_SecureHash) {
            throw new Error('Wrong checksum from VNPay response');
        }

        return {
            ...responseData,
            vnp_Message: getResponseByStatusCode(
                responseData.vnp_ResponseCode?.toString(),
                this.globalDefaultConfig.vnp_Locale,
                QUERY_DR_RESPONSE_MAP,
            ),
        };
    }

    public async refund(data: Refund) {
        const vnp_Command = 'refund';

        const dataQuery = {
            ...data,
            vnp_Command,
            vnp_Version: this.globalDefaultConfig.vnp_Version,
            vnp_TmnCode: this.globalDefaultConfig.tmnCode,
        };

        const url = new URL(
            resolveUrlString(
                this.globalDefaultConfig.vnpayHost ?? VNPAY_GATEWAY_SANDBOX_HOST,
                QUERY_DR_REFUND_ENDPOINT,
            ),
        );
        const stringToSigned =
            `${dataQuery.vnp_RequestId}|${dataQuery.vnp_Version}|${vnp_Command}|${dataQuery.vnp_TmnCode}|` +
            `${dataQuery.vnp_TransactionType}|${dataQuery.vnp_TxnRef}|${dataQuery.vnp_Amount}|` +
            `${dataQuery.vnp_TransactionNo}|${dataQuery.vnp_TransactionDate}|${dataQuery.vnp_CreateBy}|` +
            `${dataQuery.vnp_CreateDate}|${dataQuery.vnp_IpAddr}|${dataQuery.vnp_OrderInfo}`;

        const signed = hash(
            this.globalDefaultConfig.secureSecret,
            Buffer.from(stringToSigned, this.BUFFER_ENCODE),
            this.HASH_ALGORITHM,
        );

        const body = {
            ...dataQuery,
            vnp_SecureHash: signed,
        };

        const response = await fetch(url.toString(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const responseData = (await response.json()) as RefundResponse;

        if (
            Number(responseData.vnp_ResponseCode) >= 90 &&
            Number(responseData.vnp_ResponseCode) <= 99
        ) {
            return {
                ...responseData,
                vnp_Message: getResponseByStatusCode(
                    responseData.vnp_ResponseCode?.toString(),
                    this.globalDefaultConfig.vnp_Locale,
                    QUERY_DR_RESPONSE_MAP,
                ),
            };
        }

        const stringToChecksumResponse =
            `${responseData.vnp_ResponseId}|${vnp_Command}|${responseData.vnp_ResponseCode}|` +
            `${responseData.vnp_Message}|${responseData.vnp_TmnCode}|${responseData.vnp_TxnRef}|` +
            `${responseData.vnp_Amount}|${responseData.vnp_BankCode}|${responseData.vnp_PayDate}|` +
            `${responseData.vnp_TransactionNo}|${responseData.vnp_TransactionType}|` +
            `${responseData.vnp_TransactionStatus}|${responseData.vnp_OrderInfo}`;

        const signedResponse = hash(
            this.globalDefaultConfig.secureSecret,
            Buffer.from(stringToChecksumResponse, this.BUFFER_ENCODE),
            this.HASH_ALGORITHM,
        );

        if (signedResponse !== responseData.vnp_SecureHash) {
            throw new Error('Wrong checksum from VNPay response');
        }

        return {
            ...responseData,
            vnp_Message: getResponseByStatusCode(
                responseData.vnp_ResponseCode?.toString(),
                this.globalDefaultConfig.vnp_Locale,
                REFUND_RESPONSE_MAP,
            ),
        };
    }
}

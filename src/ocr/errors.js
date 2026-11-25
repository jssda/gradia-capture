// 统一的错误类型: 所有对外抛出的失败都带机器可读的 code, UI 层据此给出可操作提示.
export class OcrError extends Error {
    constructor(code, message, detail = '') {
        super(message);
        this.name = 'OcrError';
        this.code = code;
        this.detail = detail ? String(detail).slice(0, 500) : '';
    }
}

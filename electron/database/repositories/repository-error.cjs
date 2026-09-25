class RepositoryError extends Error {
  /**
   * 안정적인 오류 code, 사용자용 한국어 메시지, 원본 오류를 함께 보관한다.
   */
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "RepositoryError";
    this.code = code;
  }
}

module.exports = { RepositoryError };

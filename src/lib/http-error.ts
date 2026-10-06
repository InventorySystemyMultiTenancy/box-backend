/** Erro com status HTTP e mensagem pro usuário — convertido em JSON pelo tratador global (app.ts). */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class DeliveryTicketError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 409,
  ) {
    super(message);
    this.name = "DeliveryTicketError";
  }
}

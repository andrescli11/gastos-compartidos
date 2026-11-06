import "server-only";
import { createApi, type Action } from "./api";
import {
  accessRepository,
  expenseRepository,
  paymentRepository,
} from "./database";
import { errorResponse } from "./http";
export async function route(request: Request, action: Action) {
  try {
    const handle = createApi({
      access: accessRepository(),
      expenses: expenseRepository(),
      payments: paymentRepository(),
      appUrl: process.env.APP_URL ?? "",
      rateSecret: process.env.RATE_LIMIT_SECRET ?? "",
      vercel: process.env.VERCEL === "1",
    });
    return await handle(request, action);
  } catch (e) {
    return errorResponse(e);
  }
}

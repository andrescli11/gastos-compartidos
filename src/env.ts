if (typeof window !== "undefined")
  throw new Error("Módulo exclusivo del servidor.");
import { z } from "zod";
const serverSchema = z.object({
  APP_URL: z.url(),
  DATABASE_URL: z.url().refine((value) => /^postgres(ql)?:/.test(value)),
  RATE_LIMIT_SECRET: z.string().min(32),
});
/** Se invoca en el BFF al activar persistencia; nunca devuelve valores en errores. */
export function validateServerEnvironment(
  input: Record<string, string | undefined>,
) {
  const result = serverSchema.safeParse(input);
  if (!result.success)
    throw new Error("Configuración del servidor incompleta o inválida.");
  return result.data;
}

export type Actor = { role: 'participant'; participantId: string } | { role: 'admin' };
function validActor(actor: Actor) {
  return actor.role === 'admin' || (actor.role === 'participant' && !!actor.participantId.trim());
}
/** Identidad ya verificada por el servidor. Nunca construir Actor desde el payload del cliente. */
export function canCreateExpense(actor: Actor, payerId: string): boolean {
  return validActor(actor) && !!payerId.trim() && (actor.role === 'admin' || actor.participantId === payerId);
}
export function canEditExpense(actor: Actor, storedPayerId: string, proposedPayerId: string): boolean {
  return canCreateExpense(actor,storedPayerId) && canCreateExpense(actor,proposedPayerId);
}
export function canDeleteExpense(actor: Actor, storedPayerId: string): boolean {
  return canCreateExpense(actor,storedPayerId);
}
export function canRegisterPayment(actor: Actor, senderId: string): boolean {
  return canCreateExpense(actor,senderId);
}
export function canReviewPayment(actor: Actor, receiverId: string): boolean {
  return canCreateExpense(actor,receiverId);
}
export function canAdminister(actor: Actor): boolean { return actor.role === 'admin'; }

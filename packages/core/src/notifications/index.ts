// Notification domain rules.
//
// Pure, and narrow on purpose. The only genuine domain logic notifications
// carry is the transport lifecycle — everything else about a notification
// (which template, which destination, which secret) is a decision the
// application layer makes from authoritative records it must load first.
export * from "./delivery-state.js";

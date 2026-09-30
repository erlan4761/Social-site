
/**
 * Детали мессенджера, общие для личной переписки и группового чата: у них
 * разные API и разные шапки, но лента сообщений, пузырь, меню действий и поле
 * ввода одни.
 */
export * from './chat/format';
export * from './chat/status';
export * from './chat/MessageList';
export * from './chat/MessageText';
export { plainText } from './chat/markup';
export * from './chat/Composer';
export * from './chat/ConversationSearch';
export * from './chat/PaneParts';

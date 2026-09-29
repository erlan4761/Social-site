/**
 * Подставной бэкенд для витрины на GitHub Pages.
 *
 * Pages раздаёт только статику: ни Node-процесса, ни базы, ни диска под
 * загрузки. Поэтому здесь те же методы, что у настоящего api, но всё живёт в
 * памяти вкладки. Перезагрузка возвращает засеянное состояние — так и написано
 * в плашке, чтобы демо ничего не обещало сверх того, что делает.
 *
 * В обычную сборку этот файл не попадает: см. переключение в api.ts.
 */
import { deliverDueScheduled } from './model/scheduled';
import { seed } from './seed';
import { authApi } from './api/auth';
import { peopleApi } from './api/people';
import { postsApi } from './api/posts';
import { dmApi } from './api/dm';
import { notificationsApi } from './api/notifications';
import { chatsApi } from './api/chats';
import { channelsApi } from './api/channels';
import { scheduledApi } from './api/scheduled';
import { pollsApi } from './api/polls';
import { foldersApi } from './api/folders';
import { draftsApi } from './api/drafts';

/**
 * Ошибка метода витрины — отклонённый промис, как у настоящего api, а не
 * исключение в момент вызова. Методы проверяют ввод через `fail()` ещё до
 * `tick()`, и без этой обёртки `api.x().catch(...)` на экране не срабатывал
 * бы вовсе: исключение вылетало раньше, чем появлялся промис, и роняло
 * страницу целиком (так было со ссылкой на несуществующий чат).
 */
export function rejectInsteadOfThrow<T extends object>(methods: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(methods)) {
    wrapped[name] = (...args: unknown[]) => {
      try {
        return (fn as (...a: unknown[]) => unknown)(...args);
      } catch (err) {
        return Promise.reject(err);
      }
    };
  }
  return wrapped as T;
}

/** Все методы витрины — те же имена и ответы, что у настоящего api (проверяет компилятор в api.ts). */
export const mockApi = rejectInsteadOfThrow({
  ...authApi,
  ...peopleApi,
  ...postsApi,
  ...dmApi,
  ...notificationsApi,
  ...chatsApi,
  ...channelsApi,
  ...scheduledApi,
  ...pollsApi,
  ...foldersApi,
  ...draftsApi,
});

// Засев только в режиме витрины: в обычной сборке ветка мертва, и мок
// вместе с этими данными выбрасывается из бандла целиком.
if (import.meta.env.VITE_DEMO === '1') {
  seed();
  // Планировщик витрины — раз в секунду, как SCHEDULE_TICK_MS на сервере.
  setInterval(() => deliverDueScheduled(), 1000);
}

import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Post } from './api';
import { PostRow } from './components/PostRow';
import { resetViewTracking } from './postViews';

vi.mock('./session', () => ({
  useSession: () => ({ user: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null } }),
}));

/** Поддельный наблюдатель: тест сам говорит, видна ли строка. */
let observed: { cb: IntersectionObserverCallback; disconnected: boolean }[] = [];
class FakeObserver {
  entry: { cb: IntersectionObserverCallback; disconnected: boolean };
  constructor(cb: IntersectionObserverCallback) {
    this.entry = { cb, disconnected: false };
    observed.push(this.entry);
  }
  observe() {}
  disconnect() {
    this.entry.disconnected = true;
  }
}
const show = (visible: boolean, ratio = 0.8) =>
  act(() => {
    for (const o of observed) {
      o.cb([{ isIntersecting: visible, intersectionRatio: visible ? ratio : 0, intersectionRect: { height: visible ? 200 : 0 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });

const nina = { id: 2, username: 'nina', displayName: 'Нина', avatarUrl: null };
const post = (patch: Partial<Post> = {}): Post => ({
  id: 5, body: 'Запись', createdAt: new Date().toISOString(), editedAt: null, likeCount: 0, commentCount: 0,
  likedByMe: false, bookmarkedByMe: false, media: null, author: nina, ...patch,
});
const mount = (p: Post) =>
  render(
    <MemoryRouter>
      <PostRow post={p} canDelete={false} onDelete={() => undefined} onPatch={() => undefined} />
    </MemoryRouter>,
  );

describe('просмотры записей', () => {
  beforeEach(() => {
    observed = [];
    resetViewTracking();
    vi.useFakeTimers();
    vi.stubGlobal('IntersectionObserver', FakeObserver);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('видна дольше секунды — просмотр уходит пачкой, один раз', async () => {
    const record = vi.spyOn(api, 'recordViews').mockResolvedValue({ counted: 1 });
    mount(post());
    show(true);
    await act(async () => {
      vi.advanceTimersByTime(1000 + 2000);
    });
    expect(record).toHaveBeenCalledWith([5]);
    expect(observed[0].disconnected).toBe(true);
  });

  it('пролистали раньше секунды — не просмотр', async () => {
    const record = vi.spyOn(api, 'recordViews').mockResolvedValue({ counted: 0 });
    record.mockClear();
    mount(post());
    show(true);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    show(false);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('своя запись не наблюдается; число просмотров видно', () => {
    mount(post({ author: { id: 1, username: 'demo', displayName: 'Ерлан', avatarUrl: null }, viewCount: 12 }));
    expect(observed).toHaveLength(0);
    expect(screen.getByTitle('Запись видели 12 человек')).toHaveTextContent('12');
  });
});

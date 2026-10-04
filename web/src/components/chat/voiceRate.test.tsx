import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentView } from './attachments';
import { rateLabel } from '../../voiceRate';

const voice = {
  url: '/v.webm', kind: 'voice' as const, mime: 'audio/webm', name: null, size: 1000, duration: 42, wave: '1234554321',
};

afterEach(() => localStorage.clear());

describe('скорость голосовых', () => {
  it('пока слушают — кнопка «1×», нажатие: 1,5× → 2× → 1×, и она на плеере', () => {
    const { container } = render(<AttachmentView a={voice} onMediaLoad={() => undefined} onOpenImage={() => undefined} />);
    const audio = container.querySelector('audio')!;
    // До прослушивания — только время, без кнопки скорости.
    expect(screen.queryByRole('button', { name: /Скорость/ })).toBeNull();
    fireEvent.play(audio);
    const rate = screen.getByRole('button', { name: /Скорость 1× — сменить/ });
    fireEvent.click(rate);
    expect(audio.playbackRate).toBe(1.5);
    expect(screen.getByRole('button', { name: /Скорость 1,5×/ })).toHaveTextContent('1,5×');
    fireEvent.click(screen.getByRole('button', { name: /Скорость/ }));
    expect(audio.playbackRate).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: /Скорость/ }));
    expect(audio.playbackRate).toBe(1);
  });

  it('выбор общий и запоминается: второй плеер начинает с той же скорости', () => {
    const first = render(<AttachmentView a={voice} onMediaLoad={() => undefined} onOpenImage={() => undefined} />);
    fireEvent.play(first.container.querySelector('audio')!);
    fireEvent.click(screen.getByRole('button', { name: /Скорость/ }));
    expect(localStorage.getItem('voice-rate')).toBe('1.5');
    first.unmount();

    const second = render(<AttachmentView a={voice} onMediaLoad={() => undefined} onOpenImage={() => undefined} />);
    const audio = second.container.querySelector('audio')!;
    fireEvent.play(audio);
    expect(audio.playbackRate).toBe(1.5);
    expect(screen.getByRole('button', { name: /Скорость 1,5×/ })).toBeInTheDocument();
  });

  it('подпись — с запятой', () => {
    expect([1, 1.5, 2].map(rateLabel)).toEqual(['1×', '1,5×', '2×']);
  });
});

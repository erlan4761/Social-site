import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { THEMES } from '../../chatThemes';
import { ThemePicker } from './ThemePicker';

describe('выбор темы переписки', () => {
  it('образцы всех тем, выбранная отмечена, выбор — сразу', () => {
    const onChange = vi.fn();
    const { container } = render(<ThemePicker value="sea" onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(THEMES.length);
    expect(screen.getByRole('radio', { name: 'Море' })).toBeChecked();
    expect(container.querySelector('.theme-swatch[data-chat-theme="forest"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Лес' }));
    expect(onChange).toHaveBeenCalledWith('forest');
    fireEvent.click(screen.getByRole('radio', { name: 'Как везде' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

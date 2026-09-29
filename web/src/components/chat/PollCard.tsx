import { useState } from 'react';
import { type Poll } from '../../api';
import { plural } from '../../time';
import { Icon } from '../Icon';
import { Monogram } from '../Monogram';

/* ─ Опрос в пузыре ─────────────────────────────────────────────────
   Как в Телеграме: пока не проголосовал — варианты кнопками (при нескольких
   ответах — флажки и «Голосовать»), после — проценты полосами, свой выбор
   отмечен галочкой. Решает сервер: votes === null значит «результаты скрыты». */


type PollCardProps = {
  question: string;
  poll: Poll;
  readOnly: boolean;
  onVote: (options: number[]) => void;
  onClose: () => void;
};

export function PollCard({ question, poll, readOnly, onVote, onClose }: PollCardProps) {
  const [picked, setPicked] = useState<number[]>([]);
  // Автору итоги видны и без голоса, но голосует он, как все: итоги — по кнопке.
  const [peek, setPeek] = useState(false);
  const voted = poll.myVotes.length > 0;
  const resultsOpen = poll.options.some((o) => o.votes != null);
  const canVote = !poll.closed && !voted && !readOnly;
  const showResults = !canVote || peek;
  const kind = poll.closed
    ? 'Опрос завершён'
    : [poll.anonymous ? 'Анонимный опрос' : 'Открытый опрос', poll.multiple ? 'несколько ответов' : null]
      .filter(Boolean)
      .join(', ');
  const top = Math.max(0, ...poll.options.map((o) => o.votes ?? 0));

  return (
    <div className="poll" role="group" aria-label={`Опрос: ${question}`}>
      <p className="poll-question">{question}</p>
      <p className="poll-kind">{kind}</p>

      {!showResults ? (
        <ul className="poll-options">
          {poll.options.map((o) => (
            <li key={o.id}>
              {poll.multiple ? (
                <label className="poll-choice">
                  <input
                    type="checkbox"
                    checked={picked.includes(o.id)}
                    onChange={(e) =>
                      setPicked((prev) => (e.target.checked ? [...prev, o.id] : prev.filter((x) => x !== o.id)))
                    }
                  />
                  {o.text}
                </label>
              ) : (
                <button className="poll-choice" type="button" onClick={() => onVote([o.id])}>
                  <span className="poll-radio" aria-hidden="true" />
                  {o.text}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <ul className="poll-results">
          {poll.options.map((o) => {
            const votes = o.votes ?? 0;
            const share = poll.total > 0 ? Math.round((votes / poll.total) * 100) : 0;
            const mine = poll.myVotes.includes(o.id);
            return (
              <li key={o.id} className={votes === top && votes > 0 && poll.closed ? 'poll-row lead' : 'poll-row'}>
                <span className="poll-row-head">
                  <span className="poll-share">{o.votes == null ? '' : `${share}%`}</span>
                  <span className="poll-text">
                    {o.text}
                    {mine && (
                      <span className="poll-mine" title="Ваш выбор">
                        <Icon name="check" size={14} />
                        <span className="sr-only"> — ваш выбор</span>
                      </span>
                    )}
                  </span>
                  {o.voters.length > 0 && (
                    <span className="poll-voters" title={o.voters.map((v) => v.displayName).join(', ')}>
                      {o.voters.slice(0, 3).map((v) => (
                        <Monogram key={v.id} username={v.username} displayName={v.displayName} avatarUrl={v.avatarUrl} size="sm" />
                      ))}
                    </span>
                  )}
                </span>
                <span className="poll-bar" aria-hidden="true">
                  <span style={{ width: `${o.votes == null ? 0 : share}%` }} />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="poll-foot">
        <span className="poll-total">
          {poll.total === 0 ? 'Пока никто не голосовал' : `${poll.total} ${plural(poll.total, 'голос', 'голоса', 'голосов')}`}
        </span>
        {canVote && poll.multiple && !showResults && (
          <button className="btn small" type="button" disabled={picked.length === 0} onClick={() => onVote(picked)}>
            Голосовать
          </button>
        )}
        {canVote && resultsOpen && (
          <button className="btn link" type="button" aria-pressed={peek} onClick={() => setPeek((v) => !v)}>
            {peek ? 'К голосованию' : 'Результаты'}
          </button>
        )}
        {voted && !poll.closed && !readOnly && (
          <button className="btn link" type="button" onClick={() => onVote([])}>
            Отменить голос
          </button>
        )}
        {poll.canClose && !readOnly && (
          <button className="btn link" type="button" onClick={onClose}>
            Завершить опрос
          </button>
        )}
      </div>
    </div>
  );
}

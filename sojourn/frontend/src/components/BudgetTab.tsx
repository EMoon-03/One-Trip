import { useState, type CSSProperties, type FormEvent } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  useCreateExpense,
  useDeleteExpense,
  useExpenses,
  useItinerary,
  useSummary,
  useUpdateExpense,
} from '../api/hooks'
import type { Expense, ExpenseCategory, ExpenseCreate, Trip, TripSummary } from '../api/types'
import { useThemeColors } from '../theme'
import { categoryColor, formatDate, formatMoney, label, todayISO } from '../utils'
import { pendingKey, usePendingDeletes } from '../pendingDeletes'
import { useToast } from './Toast'
import { AddPanel, Icon, ListSkeleton } from './ui'

const CATEGORIES: ExpenseCategory[] = [
  'flights',
  'lodging',
  'food',
  'activities',
  'transport',
  'shopping',
  'other',
]


const lineColor = (category: string) => ({ '--c': categoryColor(category) }) as CSSProperties

const formFrom = (expense?: Expense) => ({
  description: expense?.description ?? '',
  amount: expense ? String(expense.amount) : '',
  category: expense?.category ?? ('food' as ExpenseCategory),
  spend_date: expense?.spend_date ?? todayISO(),
  is_planned: expense?.is_planned ?? false,
  activity_id: expense?.activity_id ? String(expense.activity_id) : '',
})

/** Add an expense (no `expense`) or edit one. Editing also lets you flip planned → paid. */
function ExpenseForm({ trip, expense, onClose }: { trip: Trip; expense?: Expense; onClose: () => void }) {
  const editing = expense !== undefined
  const createExpense = useCreateExpense(trip.id)
  const updateExpense = useUpdateExpense(trip.id)
  const { data: itinerary = [] } = useItinerary(trip.id)

  const [form, setForm] = useState(() => formFrom(expense))
  const [error, setError] = useState<string | null>(null)

  type Form = ReturnType<typeof formFrom>
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  const valid = form.description.trim() && Number(form.amount) > 0
  const pending = createExpense.isPending || updateExpense.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    setError(null)
    const body: ExpenseCreate = {
      description: form.description,
      amount: Number(form.amount),
      category: form.category,
      spend_date: form.spend_date,
      is_planned: form.is_planned,
      activity_id: form.activity_id ? Number(form.activity_id) : null,
    }
    const onError = (err: Error) => setError(err.message)
    if (editing) updateExpense.mutate({ id: expense.id, body }, { onSuccess: onClose, onError })
    else createExpense.mutate(body, { onSuccess: () => setForm(formFrom()), onError })
  }

  return (
    <form onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <h2 className="panel-title">{editing ? 'Edit expense' : 'Add an expense'}</h2>
      <div className="form-grid">
        <label className="field">
          Description
          <input
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Omakase deposit"
            autoFocus
          />
        </label>
        <label className="field">
          Amount ({trip.base_currency})
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={form.amount}
            onChange={(e) => set('amount', e.target.value)}
            placeholder="0.00"
          />
        </label>
        <label className="field">
          Category
          <select value={form.category} onChange={(e) => set('category', e.target.value as ExpenseCategory)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Date
          <input type="date" value={form.spend_date} onChange={(e) => set('spend_date', e.target.value)} />
        </label>
        <label className="field">
          <span>
            For a stop <span className="hint">optional</span>
          </span>
          <select value={form.activity_id} onChange={(e) => set('activity_id', e.target.value)}>
            <option value="">None</option>
            {itinerary.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={form.is_planned}
            onChange={(e) => set('is_planned', e.target.checked)}
          />
          Planned, not paid yet
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!valid || pending}>
          {editing ? 'Save changes' : 'Add expense'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {editing ? 'Cancel' : 'Close'}
        </button>
      </div>
    </form>
  )
}

/** Horizontal bars per category: solid = spent, faded = planned. */
function CategoryBars({ summary, currency }: { summary: TripSummary; currency: string }) {
  const max = Math.max(...summary.by_category.map((c) => c.spent + c.planned), 1)
  return (
    <div className="chart-box">
      <h2 className="section-title">By category</h2>
      <div className="legend">
        <span>
          <i className="swatch" /> Spent
        </span>
        <span>
          <i className="swatch planned" /> Planned
        </span>
      </div>
      <ul className="cat-bars">
        {summary.by_category.map((c) => (
          <li key={c.category} className="cat-bar" style={lineColor(c.category)}>
            <span>{label(c.category)}</span>
            <span className="cat-bar-track" aria-hidden="true">
              <span className="cat-bar-spent" style={{ width: `${(c.spent / max) * 100}%` }} />
              <span className="cat-bar-planned" style={{ width: `${(c.planned / max) * 100}%` }} />
            </span>
            <span className="cat-bar-amt">
              {formatMoney(c.spent + c.planned, currency)}
              {c.planned > 0 && <small>{formatMoney(c.planned, currency)} planned</small>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SpendChart({ summary, currency }: { summary: TripSummary; currency: string }) {
  // Chart libraries can't read CSS variables, so read the theme's values.
  const c = useThemeColors()
  const AXIS = { fontSize: 12, fill: c.faint, fontFamily: 'inherit' }
  // Round the axis up to a friendly step (…, 500, 1000, 2000, 2500, 5000, …)
  // and always leave room for the budget line.
  const last = summary.daily_spend.at(-1)?.cumulative ?? 0
  const top = Math.max(summary.total_budget, last, 1) * 1.05
  const magnitude = 10 ** Math.floor(Math.log10(top / 4))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s * 4 >= top) ?? magnitude * 10
  const ticks = [0, step, step * 2, step * 3, step * 4]
  return (
    <div className="chart-box">
      <h2 className="section-title">Spending over time</h2>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={summary.daily_spend} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={c.line} />
          <XAxis
            dataKey="date"
            tick={AXIS}
            tickLine={false}
            axisLine={{ stroke: c.line }}
            tickFormatter={(d: any) => formatDate(String(d))}
            minTickGap={24}
          />
          <YAxis
            tick={AXIS}
            tickLine={false}
            axisLine={false}
            width={52}
            domain={[0, step * 4]}
            ticks={ticks}
            tickFormatter={(v: any) => formatMoney(Number(v), currency)}
          />
          <Tooltip
            formatter={(value: any) => formatMoney(Number(value), currency)}
            labelFormatter={(d: any) => formatDate(String(d))}
            contentStyle={{ borderRadius: 6, borderColor: c.line, background: c.raised, color: c.ink, fontSize: 13 }}
            labelStyle={{ color: c.muted }}
          />
          {summary.total_budget > 0 && (
            <ReferenceLine
              y={summary.total_budget}
              stroke={c.lineStrong}
              strokeDasharray="4 4"
              label={{ value: 'Budget', position: 'insideTopRight', fontSize: 12, fill: c.muted }}
            />
          )}
          <Area
            type="stepAfter"
            dataKey="cumulative"
            name="Spent so far"
            stroke={c.ink}
            strokeWidth={2}
            fill={c.ink}
            fillOpacity={0.06}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function BudgetTab({ trip }: { trip: Trip }) {
  const { data: summary } = useSummary(trip.id)
  const { data: allExpenses = [], isLoading } = useExpenses(trip.id)
  const { undoableDelete } = useToast()
  const pending = usePendingDeletes()
  const expenses = allExpenses.filter((e) => !pending.has(pendingKey('expense', e.id)))
  const { data: itinerary = [] } = useItinerary(trip.id)
  const deleteExpense = useDeleteExpense(trip.id)
  const [editingId, setEditingId] = useState<number | null>(null)

  const cur = trip.base_currency
  const stopById = new Map(itinerary.map((item) => [item.id, item]))

  return (
    <div className="tab-body">
      {summary && (
        <div className="stats">
          <div className="stat">
            <p className="stat-label">Budget</p>
            <p className="stat-num">{formatMoney(summary.total_budget, cur)}</p>
          </div>
          <div className="stat">
            <p className="stat-label">Spent</p>
            <p className="stat-num">{formatMoney(summary.total_spent, cur)}</p>
          </div>
          <div className="stat">
            <p className="stat-label">Planned</p>
            <p className="stat-num">{formatMoney(summary.total_planned, cur)}</p>
          </div>
          <div className="stat">
            <p className="stat-label">{summary.remaining < 0 ? 'Over budget' : 'Left to spend'}</p>
            <p className={summary.remaining < 0 ? 'stat-num neg' : 'stat-num'}>
              {formatMoney(Math.abs(summary.remaining), cur)}
            </p>
          </div>
        </div>
      )}

      {summary && summary.by_category.length > 0 && (
        <div className="budget-grid">
          <CategoryBars summary={summary} currency={cur} />
          {summary.daily_spend.length > 0 && <SpendChart summary={summary} currency={cur} />}
        </div>
      )}

      <section>
        <h2 className="section-title">
          Expenses{expenses.length > 0 && <span className="count">{expenses.length}</span>}
        </h2>
        {isLoading && <ListSkeleton rows={4} />}
        {!isLoading && expenses.length === 0 && (
          <p className="empty">No expenses yet. Add bookings as you make them, or plan costs ahead of time.</p>
        )}
        {expenses.length > 0 && (
          <ul className="list">
            {expenses.map((expense) => {
              const stop = expense.activity_id ? stopById.get(expense.activity_id) : undefined
              if (editingId === expense.id) {
                return (
                  <li key={expense.id} className="list-row is-editing">
                    <div className="panel">
                      <ExpenseForm trip={trip} expense={expense} onClose={() => setEditingId(null)} />
                    </div>
                  </li>
                )
              }
              return (
                <li key={expense.id} className={expense.is_planned ? 'list-row is-planned' : 'list-row'}>
                  <span className="expense-date">{formatDate(expense.spend_date)}</span>
                  <div className="row-main">
                    <p className="row-title">{expense.description}</p>
                    <p className="row-sub">
                      <span className="cat" style={lineColor(expense.category)}>
                        {label(expense.category)}
                      </span>
                      <span className="expense-date-inline">{formatDate(expense.spend_date)}</span>
                      {stop && <span>For {stop.title}</span>}
                    </p>
                  </div>
                  <span className="expense-amt">
                    {formatMoney(expense.amount, expense.currency)}
                    {expense.is_planned && <small>Planned</small>}
                  </span>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="icon-btn edit"
                      aria-label={`Edit ${expense.description}`}
                      title="Edit expense"
                      onClick={() => setEditingId(expense.id)}
                    >
                      <Icon name="edit" size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Delete ${expense.description}`}
                      title="Delete expense"
                      onClick={() =>
                        undoableDelete({
                          key: pendingKey('expense', expense.id),
                          label: expense.description,
                          commit: () => deleteExpense.mutate(expense.id),
                        })
                      }
                    >
                      <Icon name="x" size={15} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <AddPanel label="Add expense">{(close) => <ExpenseForm trip={trip} onClose={close} />}</AddPanel>
    </div>
  )
}

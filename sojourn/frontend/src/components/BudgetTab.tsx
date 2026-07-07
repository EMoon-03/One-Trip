import { useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  useCreateExpense,
  useDeleteExpense,
  useExpenses,
  useItinerary,
  useSummary,
} from '../api/hooks'
import type { ExpenseCategory, ExpenseCreate, Trip } from '../api/types'
import { categoryColor, formatDate, formatMoney, todayISO } from '../utils'

const CATEGORIES: ExpenseCategory[] = [
  'flights',
  'lodging',
  'food',
  'activities',
  'transport',
  'shopping',
  'other',
]

const MONO = 'IBM Plex Mono, monospace'

function AddExpenseForm({ trip }: { trip: Trip }) {
  const createExpense = useCreateExpense(trip.id)
  const { data: itinerary = [] } = useItinerary(trip.id)

  const blank = () => ({
    description: '',
    amount: '',
    category: 'food' as ExpenseCategory,
    spend_date: todayISO(),
    is_planned: false,
    activity_id: '',
  })
  const [form, setForm] = useState(blank())
  const [error, setError] = useState<string | null>(null)

  const set = <K extends keyof ReturnType<typeof blank>>(key: K, value: ReturnType<typeof blank>[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = () => {
    setError(null)
    const body: ExpenseCreate = {
      description: form.description,
      amount: Number(form.amount),
      category: form.category,
      spend_date: form.spend_date,
      is_planned: form.is_planned,
      activity_id: form.activity_id ? Number(form.activity_id) : null,
    }
    createExpense.mutate(body, {
      onSuccess: () => setForm(blank()),
      onError: (e) => setError(e.message),
    })
  }

  return (
    <div className="card form-card">
      <h3 className="card-title">Log expense</h3>
      <div className="form-grid">
        <label>
          Description
          <input
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Omakase deposit"
          />
        </label>
        <label>
          Amount ({trip.base_currency})
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.amount}
            onChange={(e) => set('amount', e.target.value)}
            placeholder="80.00"
          />
        </label>
        <label>
          Category
          <select value={form.category} onChange={(e) => set('category', e.target.value as ExpenseCategory)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          Date
          <input type="date" value={form.spend_date} onChange={(e) => set('spend_date', e.target.value)} />
        </label>
        <label>
          Tied to a stop (optional)
          <select value={form.activity_id} onChange={(e) => set('activity_id', e.target.value)}>
            <option value="">— none —</option>
            {itinerary.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={form.is_planned}
            onChange={(e) => set('is_planned', e.target.checked)}
          />
          Planned (not spent yet)
        </label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button
          type="button"
          className="btn primary"
          disabled={!form.description || Number(form.amount) <= 0 || createExpense.isPending}
          onClick={submit}
        >
          Log expense
        </button>
      </div>
    </div>
  )
}

export default function BudgetTab({ trip }: { trip: Trip }) {
  const { data: summary } = useSummary(trip.id)
  const { data: expenses = [], isLoading } = useExpenses(trip.id)
  const { data: itinerary = [] } = useItinerary(trip.id)
  const deleteExpense = useDeleteExpense(trip.id)

  const cur = trip.base_currency
  const stopById = new Map(itinerary.map((item) => [item.id, item]))

  return (
    <div className="tab-body">
      {summary && (
        <div className="stat-row">
          <div className="card stat">
            <p className="eyebrow mono">Budget</p>
            <p className="stat-num mono">{formatMoney(summary.total_budget, cur)}</p>
          </div>
          <div className="card stat">
            <p className="eyebrow mono">Spent</p>
            <p className="stat-num mono">{formatMoney(summary.total_spent, cur)}</p>
          </div>
          <div className="card stat">
            <p className="eyebrow mono">Planned</p>
            <p className="stat-num mono">{formatMoney(summary.total_planned, cur)}</p>
          </div>
          <div className="card stat">
            <p className="eyebrow mono">Remaining</p>
            <p className={summary.remaining < 0 ? 'stat-num mono neg' : 'stat-num mono'}>
              {formatMoney(summary.remaining, cur)}
            </p>
          </div>
        </div>
      )}

      {summary && summary.by_category.length > 0 && (
        <div className="chart-row">
          <div className="card chart-card">
            <h3 className="card-title">Where the money goes</h3>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={summary.by_category} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dde2e8" />
                <XAxis dataKey="category" tick={{ fontSize: 11, fontFamily: MONO }} />
                <YAxis tick={{ fontSize: 11, fontFamily: MONO }} width={54} />
                <Tooltip formatter={(value: any) => formatMoney(Number(value), cur)} />
                <Legend />
                <Bar dataKey="spent" name="spent" radius={[3, 3, 0, 0]}>
                  {summary.by_category.map((c) => (
                    <Cell key={c.category} fill={categoryColor(c.category)} />
                  ))}
                </Bar>
                <Bar dataKey="planned" name="planned" radius={[3, 3, 0, 0]}>
                  {summary.by_category.map((c) => (
                    <Cell key={c.category} fill={categoryColor(c.category)} fillOpacity={0.3} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {summary.daily_spend.length > 0 && (
            <div className="card chart-card">
              <h3 className="card-title">Spend over time</h3>
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={summary.daily_spend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dde2e8" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fontFamily: MONO }}
                    tickFormatter={(d: any) => formatDate(String(d))}
                  />
                  <YAxis tick={{ fontSize: 11, fontFamily: MONO }} width={54} />
                  <Tooltip
                    formatter={(value: any) => formatMoney(Number(value), cur)}
                    labelFormatter={(d: any) => formatDate(String(d))}
                  />
                  {summary.total_budget > 0 && (
                    <ReferenceLine
                      y={summary.total_budget}
                      stroke="#c92a2a"
                      strokeDasharray="6 4"
                      label={{
                        value: 'BUDGET',
                        position: 'insideTopRight',
                        fontSize: 10,
                        fontFamily: MONO,
                        fill: '#c92a2a',
                      }}
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey="cumulative"
                    name="running total"
                    stroke="#1c4fd8"
                    strokeWidth={2}
                    fill="#1c4fd8"
                    fillOpacity={0.12}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h3 className="card-title">Expenses</h3>
        {isLoading && <p className="empty">Loading expenses…</p>}
        {!isLoading && expenses.length === 0 && (
          <p className="empty">Nothing logged. Add an expense when you book or spend.</p>
        )}
        {expenses.map((expense) => {
          const stop = expense.activity_id ? stopById.get(expense.activity_id) : undefined
          return (
            <div key={expense.id} className="expense-row">
              <span className="expense-date mono">{formatDate(expense.spend_date)}</span>
              <span className="expense-desc">
                {expense.description}
                {stop && <span className="expense-link"> ↳ {stop.title}</span>}
              </span>
              {expense.is_planned && <span className="tag planned">planned</span>}
              <span
                className="tag"
                style={{
                  color: categoryColor(expense.category),
                  borderColor: categoryColor(expense.category),
                }}
              >
                {expense.category}
              </span>
              <span className="expense-amt mono">{formatMoney(expense.amount, expense.currency)}</span>
              <button
                type="button"
                className="btn icon"
                aria-label={`Delete ${expense.description}`}
                onClick={() => deleteExpense.mutate(expense.id)}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>

      <AddExpenseForm trip={trip} />
    </div>
  )
}

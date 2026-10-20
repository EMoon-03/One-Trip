"""Notification channels: how a due reminder reaches a person.

    console   prints to the worker's log — the zero-config dev default
    email     SMTP (any provider: Gmail app password, Mailgun, Resend, local Mailpit…)
    push      Web Push to every browser the user switched notifications on in

Every channel has the same shape (see channels.Channel), so the worker never
needs to know which one it's talking to — the provider pattern again.
"""

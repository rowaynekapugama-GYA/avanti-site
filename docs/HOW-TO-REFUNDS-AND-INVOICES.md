# Refunds and tax invoices: how to use them

## 1. Right now, before the new feature is switched on

**Which way did the customer pay?** Open the order in the dashboard (Orders, then click the order).
The Payment box shows **Stripe** (card, Apple Pay or Google Pay) or **PayPal**.

**Stripe (card payments)**
1. Log in to the Stripe Dashboard and go to **Transactions**.
2. Find the payment: search by the customer's email or the amount.
3. Click the **...** at the end of the payment's row and choose **Refund payment**, or open the payment
   and click **Refund** at the top right.
4. Leave the full amount, or type a smaller amount for a part refund.
5. Choose a reason. If you choose **Other**, add a short note.
6. Click **Refund**.

Stripe says refunds take 5 to 10 days to reach the customer, and there is only a very short window to
cancel one, so check the amount first.

**PayPal**
1. Log in to the PayPal business account and go to **Activity**.
2. Click the payment, then **Issue a refund**.
3. Enter the amount (less than the full amount for a part refund) and click **Continue**.
4. Check the details and click **Issue Refund**.

PayPal refunds can be made up to 180 days after the payment. They can't be cancelled once sent, and
PayPal keeps the fee it charged on the original payment.

**The order in the dashboard:** a full refund done this way already changes the order to Refunded on its
own. A part refund adds a note to the order's timeline. Once the new feature is on, every refund made in
Stripe or PayPal is also listed on the order with the amounts.

(Click paths checked against Stripe's "How to refund a customer" and PayPal's "How do I issue a refund?"
help pages on 20 November 2026. Neither had changed from the steps above.)

## 2. Once refunds and invoices are switched on

**Refund from the order page**
1. Open the order. In the **Refunds** box click **Refund...**
2. Choose **Full refund**, or **Part refund** and type the amount (including GST). You can't refund more
   than is left on the order.
3. Choose a reason (Order cancelled, Reprint or fault, Duplicate payment or Other) and add a note if you like.
   Other needs a note.
4. Leave **Email the customer a refund confirmation** ticked unless you've told them another way.
5. Click **Continue**, check the amount, then click **Refund $...**. This can't be undone.

The money goes back to the card or PayPal account they paid with. The customer gets "Your refund from Avanti
Print & Design" with an adjustment note attached for their records. If Stripe or PayPal refuses (for example,
not enough balance, or more than 180 days on PayPal), the dashboard says why in plain words and nothing is
recorded as refunded.

**"Not confirmed yet"**: once in a while Stripe or PayPal is slow or the connection drops, and the dashboard
can't tell whether the refund went through. The refund then shows **Not confirmed yet** and no more refunds can
be made on that order until it's checked. **Don't refund again in Stripe or PayPal.** Press **Check refund**: the
dashboard asks Stripe or PayPal what happened and updates the order (if the first request never arrived, it is
sent once, so the customer is never refunded twice). It's safe to press more than once. Stripe refunds usually
sort themselves out the next time the order is opened. For a PayPal refund more than 6 hours old, the dashboard
asks you to look in PayPal (Activity, then the payment): if the refund isn't there, press **It wasn't refunded**.

**Orders refunded before this was switched on**: a Stripe refund is brought in automatically when you open the
order. If the dashboard says the order "was refunded in Stripe or PayPal before refunds were recorded here", make
any further refund in Stripe or PayPal directly, as you do today.

- A fully refunded order shows as **Refunded**. A part refund shows **Part refunded** with what's left.
- To cancel an order and refund it, cancel it first (Cancel order), then refund it. It stays **Cancelled**
  and shows the refund.
- A refund doesn't give a discount code's use back.

**Tax invoices**
- Every paid order gets a tax invoice (AV-000001, AV-000002 and so on), emailed to the customer straight
  after they pay: "Your tax invoice from Avanti Print & Design (order ...)", with the PDF attached and a
  download link.
- On the order page, the **Tax invoice** box has **Download invoice** and **Resend invoice**. Resend can go
  to the customer or another address, such as their accounts team.
- If an invoice PDF couldn't be made at the time (rare), the box says so and shows **Make the invoice PDF**.
- An order paid before invoices were switched on shows **Generate invoice**. It gets the next number,
  dated with the original payment date, and isn't emailed until you press Resend invoice. Because of this,
  invoice numbers for older orders won't be in date order.
- Business customers can add their business name and ABN at checkout, and both appear on their invoice.

**Business details** (in the dashboard menu under Commerce): the legal business name, trading name, ABN,
address, phone, email, footer line and logo printed on every invoice. **No invoice is made until the legal
name and ABN are filled in.**

**What the customer receives after paying:** the usual order confirmation, then a separate email with their
tax invoice. If they refund, they get the refund email with an adjustment note.

If anything looks wrong, don't change it. Send GYA the order number and a screenshot.

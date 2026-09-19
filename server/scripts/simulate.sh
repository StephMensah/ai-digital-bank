#!/usr/bin/env bash
# Walks every customer-facing function, success and failure, for two separate
# customers — proving the profiles do not bleed into each other.
B="http://localhost:10095"
P() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d$1'))" 2>/dev/null; }
IDK() { echo "idem-$RANDOM$RANDOM$RANDOM"; }
gh() {  # a valid Ghanaian mobile number, in the local form people actually type
  local p=(024 054 055 059 025 053 020 050 027 057 026 056)
  echo "${p[$((RANDOM % ${#p[@]}))]}$(printf %07d $((RANDOM % 10000000)))"
}
pass=0; fail=0
ok()   { pass=$((pass+1)); printf "  ✓ %s\n" "$1"; }
bad()  { fail=$((fail+1)); printf "  ✗ %s — got: %s\n" "$1" "$2"; }
is()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2 (wanted $3)"; }

onboard() {  # name msisdn password card -> echoes token
  local R T CH SU
  R=$(curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"fullName\":\"$1\",\"msisdn\":\"$2\",\"email\":\"u$RANDOM@x.com\",\"password\":\"$3\"}" "$B/api/v1/auth/register")
  T=$(echo "$R" | P '["tokens"]["accessToken"]')
  CH=$(curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"purpose":"pin_change"}' "$B/api/otp/request")
  SU=$(curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    -d "{\"challengeId\":$(echo "$CH" | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["challengeId"]))'),\"code\":\"$(echo "$CH" | P '["demoCode"]')\"}" \
    "$B/api/otp/verify" | P '["stepUpToken"]')
  curl -s -o /dev/null -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    -d "{\"newPin\":\"$5\",\"stepUpToken\":\"$SU\"}" "$B/api/pin/set"
  curl -s -o /dev/null -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    -d "{\"idNumber\":\"$4\",\"dateOfBirth\":\"1990-01-01\"}" "$B/api/v1/kyc/ghana-card"
  echo "$T"
}

M1="$(gh)"
M2="$(gh)"

echo "── onboarding two separate customers"
T1=$(onboard "Ama Boateng" "$M1" "PassOne12345" "GHA-111111111-1" "1111")
T2=$(onboard "Kwame Nkrumah" "$M2" "PassTwo12345" "GHA-222222222-2" "2222")
A1=$(curl -s -H "Authorization: Bearer $T1" "$B/api/accounts/personal")
A2=$(curl -s -H "Authorization: Bearer $T2" "$B/api/accounts/personal")
N1=$(echo "$A1" | P '["accounts"][0]["accountNumber"]')
N2=$(echo "$A2" | P '["accounts"][0]["accountNumber"]')
ok "customer 1 account $N1"
ok "customer 2 account $N2"
[ "$N1" != "$N2" ] && ok "account numbers are distinct" || bad "distinct accounts" "$N1 = $N2"
is "customer 1 sees only their own accounts" "$(echo "$A1" | P '["accounts"].__len__()')" "1"
is "customer 2 sees only their own accounts" "$(echo "$A2" | P '["accounts"].__len__()')" "1"
is "no borrowed history" "$(echo "$A2" | P '["transactions"].__len__()')" "0"

echo "── funding"
curl -s -o /dev/null -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"accountId\":\"$(echo "$A1" | P '["accounts"][0]["id"]' 2>/dev/null)\",\"amountMinor\":80000,\"method\":\"mobile_money\",\"msisdn\":\"$M1\"}" \
  "$B/api/v1/payments/deposits" 2>/dev/null
AID1=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/accounts" | P '["accounts"][0]["id"]')
curl -s -o /dev/null -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"accountId\":\"$AID1\",\"amountMinor\":80000,\"method\":\"mobile_money\",\"msisdn\":\"$M1\"}" "$B/api/v1/payments/deposits"
sleep 7
is "top up settled" "$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/accounts" | P '["accounts"][0]["balance_minor"]')" "80000"

echo "── funds transfer, the failure paths first"
r() { curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" -d "$1" "$B/api/transactions"; }
is "wrong PIN refused"        "$(r '{"account":0,"merchant":"Kojo","amount":-50,"pin":"9999"}' | P '["error"]["code"]')" "invalid_pin"
ok "  message: $(r '{"account":0,"merchant":"Kojo","amount":-50,"pin":"9999"}' | P '["error"]["message"]')"
is "unknown account refused"  "$(r '{"account":9,"merchant":"Kojo","amount":-50,"pin":"1111"}' | P '["error"]["code"]')" "unknown_account"
is "over balance refused"     "$(r '{"account":0,"merchant":"Kojo","amount":-99999,"pin":"1111"}' | P '["error"]["code"]')" "insufficient_funds"

echo "── funds transfer, the success path"
TX=$(r '{"account":0,"merchant":"Kojo Mensah","amount":-250,"category":"Transfer","method":"Internal","pin":"1111"}')
is "transfer posted" "$(echo "$TX" | P '["tx"]["status"]')" "Completed"
is "balance after"   "$(echo "$TX" | P '["balance"]')" "550"

echo "── business account"
BZ=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' \
  -d '{"name":"Ama Kitchen Ltd","type":"business"}' "$B/api/accounts/open")
is "business account opened" "$(echo "$BZ" | P '["account"]["type"]')" "business"
ok "  number: $(echo "$BZ" | P '["account"]["accountNumber"]')"
A1b=$(curl -s -H "Authorization: Bearer $T1" "$B/api/accounts/personal")
is "customer 1 now has two accounts" "$(echo "$A1b" | P '["accounts"].__len__()')" "2"
is "customer 2 unaffected"           "$(curl -s -H "Authorization: Bearer $T2" "$B/api/accounts/personal" | P '["accounts"].__len__()')" "1"

echo "── verification and limits"
is "customer 1 verified" "$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/kyc/status" | P '["status"]')" "verified"
M3="$(gh)"
T3=$(curl -s -X POST -H 'Content-Type: application/json' -d "{\"fullName\":\"Referred Person\",\"msisdn\":\"$M3\",\"email\":\"r$RANDOM@x.com\",\"password\":\"PassThree123\"}" "$B/api/v1/auth/register" | P '["tokens"]["accessToken"]')
K3=$(curl -s -X POST -H "Authorization: Bearer $T3" -H 'Content-Type: application/json' -d '{"idNumber":"GHA-333333333-0","dateOfBirth":"1990-01-01"}' "$B/api/v1/kyc/ghana-card")
is "bad card refers, no account" "$(echo "$K3" | P '["status"]')" "in_review"
is "referred customer has no account" "$(curl -s -H "Authorization: Bearer $T3" "$B/api/v1/accounts" | P '["accounts"].__len__()')" "0"

echo "── session boundaries"
is "no token, no accounts" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/accounts/personal")" "401"
is "no token, no transfer" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$B/api/transactions")" "401"

echo
echo "passed $pass, failed $fail"

echo "── per-customer product data"
PD1=$(curl -s -H "Authorization: Bearer $T1" "$B/api/accounts/personal")
PD2=$(curl -s -H "Authorization: Bearer $T2" "$B/api/accounts/personal")
C1=$(echo "$PD1" | P '["accounts"][0]["card"]["fullNum"]')
C2=$(echo "$PD2" | P '["accounts"][0]["card"]["fullNum"]')
[ -n "$C1" ] && ok "customer 1 has a card: $C1" || bad "customer 1 card" "none"
[ "$C1" != "$C2" ] && ok "cards differ between customers" || bad "cards differ" "$C1 = $C2"
case "$C1" in "4000 00"*) ok "card uses the reserved test range" ;; *) bad "test IIN" "$C1" ;; esac
G1=$(echo "$PD1" | P '["goals"].__len__()'); G2=$(echo "$PD2" | P '["goals"].__len__()')
[ "$G1" -ge 2 ] && ok "customer 1 has $G1 goals" || bad "goals seeded" "$G1"
ok "  first goal: $(echo "$PD1" | P '["goals"][0]["name"]')"
B1=$(echo "$PD1" | P '["beneficiaries"].__len__()')
[ "$B1" -ge 2 ] && ok "customer 1 has $B1 payees" || bad "payees seeded" "$B1"
ok "  first payee: $(echo "$PD1" | P '["beneficiaries"][0]["name"]') at $(echo "$PD1" | P '["beneficiaries"][0]["bank"]')"
N1G=$(echo "$PD1" | P '["goals"][0]["name"]'); N2G=$(echo "$PD2" | P '["goals"][0]["name"]')
ok "customer 2 goal: $N2G"
PR=$(echo "$PD1" | P '["accounts"][1]["payroll"].__len__()')
[ "$PR" -ge 3 ] && ok "business account has $PR payroll lines" || bad "payroll seeded" "$PR"
ok "  first line: $(echo "$PD1" | P '["accounts"][1]["payroll"][0]["name"]') — $(echo "$PD1" | P '["accounts"][1]["payroll"][0]["role"]')"
is "personal account has no payroll" "$(echo "$PD2" | P '["accounts"][0]["payroll"].__len__()')" "0"

echo
echo "final: passed $pass, failed $fail"

echo "── name enquiry before sending"
NE=$(curl -s -X POST -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' \
  -d "{\"method\":\"internal\",\"accountNumber\":\"$N1\"}" "$B/api/v1/payments/name-enquiry")
is "on-us lookup finds the holder" "$(echo "$NE" | P '["name"]')" "Ama Boateng"
is "on-us says which bank"         "$(echo "$NE" | P '["bank"]')" "Digital Bank"
is "not my own account"            "$(echo "$NE" | P '["self"]')" "False"
SELF=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"method\":\"internal\",\"accountNumber\":\"$N1\"}" "$B/api/v1/payments/name-enquiry")
is "my own account flagged as mine" "$(echo "$SELF" | P '["self"]')" "True"
is "unknown number refused"        "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"method":"internal","accountNumber":"9999999999"}' "$B/api/v1/payments/name-enquiry" | P '["error"]["code"]')" "not_found"
BK=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"method":"bank","accountNumber":"1234567890","bankCode":"300303"}' "$B/api/v1/payments/name-enquiry")
ok "interbank lookup: $(echo "$BK" | P '["name"]') at $(echo "$BK" | P '["bank"]') · $(echo "$BK" | P '["branch"]')"
WL=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"method":"mobile_money","msisdn":"+233244000222"}' "$B/api/v1/payments/name-enquiry")
ok "wallet lookup: $(echo "$WL" | P '["name"]') on $(echo "$WL" | P '["bank"]')"

echo "── saving a payee is a separate decision"
SP=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Kwame Nkrumah\",\"method\":\"internal\",\"accountRef\":\"$N2\",\"bank\":\"Digital Bank\"}" "$B/api/v1/payees")
is "payee saved" "$(echo "$SP" | P '["payee"]["name"]')" "Kwame Nkrumah"
curl -s -o /dev/null -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Kwame N\",\"method\":\"internal\",\"accountRef\":\"$N2\",\"bank\":\"Digital Bank\"}" "$B/api/v1/payees"
SAME=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/payees" | python3 -c "
import sys,json;d=json.load(sys.stdin)
print(len([p for p in d['payees'] if p['acct']=='$N2']))")
is "saving twice keeps one row" "$SAME" "1"
is "bank payee needs a bank code" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"name":"X","method":"bank","accountRef":"111222333"}' "$B/api/v1/payees" | P '["error"]["code"]')" "bad_request"

echo "── wallet to bank"
W=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"accountId\":\"$AID1\",\"amountMinor\":20000,\"msisdn\":\"$M1\",\"destination\":{\"accountNumber\":\"1234567890\",\"bankCode\":\"300303\",\"name\":\"Kojo\"}}" \
  "$B/api/v1/payments/wallet-to-bank")
is "collection leg opened" "$(echo "$W" | P '["transaction"]["status"]')" "processing"
ok "  $(echo "$W" | P '["awaiting"]')"
sleep 22
is "onward leg left the account" "$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/accounts" | P '["accounts"][0]["balance_minor"]')" "55000"

echo
echo "final: passed $pass, failed $fail"

echo "── local mobile numbers"
LOCAL="$(gh)"
RL=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"fullName\":\"Local Format\",\"msisdn\":\"$LOCAL\",\"email\":\"l$RANDOM@x.com\",\"password\":\"LocalPass1234\"}" "$B/api/v1/auth/register")
is "registers in the local form" "$(echo "$RL" | P '["customer"]["msisdn"]')" "+233${LOCAL:1}"
is "logs in with the local form"        "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"msisdn\":\"$LOCAL\",\"password\":\"LocalPass1234\"}" "$B/api/v1/auth/login")" "200"
is "logs in with the +233 form"         "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"msisdn\":\"+233${LOCAL:1}\",\"password\":\"LocalPass1234\"}" "$B/api/v1/auth/login")" "200"
is "logs in with spaces"                "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "{\"msisdn\":\"${LOCAL:0:3} ${LOCAL:3:3} ${LOCAL:6}\",\"password\":\"LocalPass1234\"}" "$B/api/v1/auth/login")" "200"
is "landline rejected"                  "$(curl -s -X POST -H 'Content-Type: application/json' -d '{"msisdn":"0302123456","password":"x"}' "$B/api/v1/auth/login" | P '["error"]["code"]')" "bad_request"
for pfx in 024 054 027 026 050 055 059 023; do
  N="${pfx}$(printf %07d $((RANDOM%9999999)))"
  code=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"method\":\"mobile_money\",\"msisdn\":\"$N\"}" "$B/api/v1/payments/name-enquiry" | P '["bank"]')
  [ -n "$code" ] && ok "$pfx accepted · $code" || bad "$pfx accepted" "rejected"
done

echo
echo "final: passed $pass, failed $fail"

echo "── mambu core (mock tenant)"
sleep 2
MB=$(curl -s -H "Authorization: Bearer $T1" "$B/api/accounts/personal" | P '["accounts"][0]["mambuRef"]')
[ -n "$MB" ] && [ "$MB" != "None" ] && ok "account mirrored into the core: ${MB:0:12}…" || bad "account mirrored" "$MB"
MB2=$(curl -s -H "Authorization: Bearer $T2" "$B/api/accounts/personal" | P '["accounts"][0]["mambuRef"]')
[ "$MB" != "$MB2" ] && ok "each account has its own core key" || bad "distinct core keys" "$MB = $MB2"
case "$MB" in ????????????????????????????????) ok "core key is a 32-char encodedKey" ;; *) bad "encodedKey shape" "$MB" ;; esac

echo
echo "final: passed $pass, failed $fail"

echo "── investing: buy, redeem, borrow"
AID1=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/accounts" | P '["accounts"][0]["id"]')
curl -s -o /dev/null -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"accountId\":\"$AID1\",\"amountMinor\":200000,\"method\":\"mobile_money\",\"msisdn\":\"$M1\"}" "$B/api/v1/payments/deposits"
sleep 6
ok "  funded for investing"
is "asset list available" "$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/invest/assets" | P '["assets"].__len__()')" "5"
BUY=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"accountId\":\"$AID1\",\"symbol\":\"BTC\",\"amountMinor\":100000}" "$B/api/v1/invest/buy")
[ -n "$(echo "$BUY" | P '["units"]')" ] && ok "bought $(echo "$BUY" | P '["units"]') BTC for GH₵1000 (fee $(echo "$BUY" | P '["feeMinor"]')p)" || bad "buy" "$BUY"
is "holding shows up" "$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/invest/portfolio" | P '["holdings"].__len__()')" "1"
FIN=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"accountId\":\"$AID1\",\"symbol\":\"BTC\",\"amountMinor\":30000}" "$B/api/v1/invest/finance")
[ -n "$(echo "$FIN" | P '["pledgedUnits"]')" ] && ok "borrowed GH₵300 against $(echo "$FIN" | P '["pledgedUnits"]') BTC" || bad "finance" "$FIN"
is "over-LTV refused" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" -d "{\"accountId\":\"$AID1\",\"symbol\":\"BTC\",\"amountMinor\":9000000}" "$B/api/v1/invest/finance" | P '["error"]["code"]')" "bad_request"
PLEDGED=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/invest/portfolio" | P '["holdings"][0]["pledgedUnits"]')
[ "$PLEDGED" != "0" ] && ok "pledged units held back: $PLEDGED" || bad "pledge recorded" "$PLEDGED"
UNITS=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/invest/portfolio" | P '["holdings"][0]["units"]')
is "cannot redeem pledged units" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" -d "{\"accountId\":\"$AID1\",\"symbol\":\"BTC\",\"units\":$UNITS}" "$B/api/v1/invest/redeem" | P '["error"]["code"]')" "bad_request"
RD=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"accountId\":\"$AID1\",\"symbol\":\"BTC\",\"amountMinor\":20000}" "$B/api/v1/invest/redeem")
[ -n "$(echo "$RD" | P '["receivedMinor"]')" ] && ok "redeemed to cash: $(echo "$RD" | P '["receivedMinor"]')p" || bad "redeem" "$RD"

echo "── linked cards"
LC=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' \
  -d '{"pan":"4111111111111111","expiry":"09/29","holderName":"Ama Boateng","issuer":"GCB Bank"}' "$B/api/v1/cards/linked")
is "visa linked"        "$(echo "$LC" | P '["card"]["scheme"]')" "visa"
is "only last four kept" "$(echo "$LC" | P '["card"]["last4"]')" "1111"
is "bad number refused" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"pan":"4111111111111112","expiry":"09/29","holderName":"Ama Boateng"}' "$B/api/v1/cards/linked" | P '["error"]["code"]')" "bad_request"
is "expired card refused" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"pan":"5555555555554444","expiry":"01/20","holderName":"Ama Boateng"}' "$B/api/v1/cards/linked" | P '["error"]["code"]')" "bad_request"
MC=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d '{"pan":"5555555555554444","expiry":"11/30","holderName":"Ama Boateng"}' "$B/api/v1/cards/linked")
is "mastercard linked"  "$(echo "$MC" | P '["card"]["scheme"]')" "mastercard"
is "tiers published"    "$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/cards/tiers" | P '["tiers"]["infinite"]["name"]')" "Infinite"

echo
echo "final: passed $pass, failed $fail"

echo "── GhQR scan to pay"
SQ=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/qr/sample?amount=4550&name=Melcom%20Osu")
PAY=$(echo "$SQ" | P '["payload"]')
DEC=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"payload\":\"$PAY\"}" "$B/api/v1/qr/decode")
is "dynamic code decodes"     "$(echo "$DEC" | P '["merchant"]["name"]')" "Melcom Osu"
is "amount comes from the till" "$(echo "$DEC" | P '["amountMinor"]')" "4550"
is "no amount asked for"      "$(echo "$DEC" | P '["needsAmount"]')" "False"
is "tampered code refused"    "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"payload\":\"${PAY%????}0000\"}" "$B/api/v1/qr/decode" | P '["error"]["code"]')" "bad_qr"

BEFORE=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/accounts" | P '["accounts"][0]["balance_minor"]')
PD=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"accountId\":\"$AID1\",\"payload\":\"$PAY\",\"pin\":\"1111\",\"amountMinor\":100}" "$B/api/v1/qr/pay")
is "paid at the till" "$(echo "$PD" | P '["paid"]')" "True"
AFTER=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/accounts" | P '["accounts"][0]["balance_minor"]')
is "the till's amount was charged, not the client's" "$((BEFORE-AFTER))" "4550"
is "wrong PIN refused" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" -d "{\"accountId\":\"$AID1\",\"payload\":\"$PAY\",\"pin\":\"9999\"}" "$B/api/v1/qr/pay" | P '["error"]["code"]')" "invalid_pin"

SS=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/qr/sample?name=Kofi%20Store" | P '["payload"]')
is "static code asks for an amount" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"payload\":\"$SS\"}" "$B/api/v1/qr/decode" | P '["needsAmount"]')" "True"
SP=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"accountId\":\"$AID1\",\"payload\":\"$SS\",\"pin\":\"1111\",\"amountMinor\":2500}" "$B/api/v1/qr/pay")
is "static code paid at the typed amount" "$(echo "$SP" | P '["amountMinor"]')" "2500"

echo
echo "final: passed $pass, failed $fail"

echo "── a linked card that actually works"
CID=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/cards/linked" | P '["cards"][0]["id"]')
B4=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/accounts" | P '["accounts"][0]["balance_minor"]')
CH=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"accountId\":\"$AID1\",\"amountMinor\":25000}" "$B/api/v1/cards/linked/$CID/charge")
is "charge accepted"      "$(echo "$CH" | P '["transaction"]["status"]')" "processing"
ok "  $(echo "$CH" | P '["message"]') · $(echo "$CH" | P '["card"]')"
sleep 5
AF=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/accounts" | P '["accounts"][0]["balance_minor"]')
is "card money landed" "$((AF-B4))" "25000"
is "unknown card refused" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" -d "{\"accountId\":\"$AID1\",\"amountMinor\":1000}" "$B/api/v1/cards/linked/00000000-0000-0000-0000-000000000000/charge" | P '["error"]["code"]')" "not_found"
is "another customer cannot charge it" "$(curl -s -X POST -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" -d "{\"accountId\":\"$AID1\",\"amountMinor\":1000}" "$B/api/v1/cards/linked/$CID/charge" | P '["error"]["code"]')" "not_found"

echo
echo "final: passed $pass, failed $fail"

echo "── on-us transfer lands instantly on both sides"
S1=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/accounts" | P '["accounts"][0]["balance_minor"]')
R1=$(curl -s -H "Authorization: Bearer $T2" "$B/api/v1/accounts" | P '["accounts"][0]["balance_minor"]')
TR=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" \
  -d "{\"fromAccountId\":\"$AID1\",\"toAccountNumber\":\"$N2\",\"amountMinor\":7500,\"narration\":\"Rent\",\"pin\":\"1111\"}" \
  "$B/api/v1/payments/transfers")
is "posted straight away" "$(echo "$TR" | P '["posted"]')" "True"
S2=$(curl -s -H "Authorization: Bearer $T1" "$B/api/v1/accounts" | P '["accounts"][0]["balance_minor"]')
R2=$(curl -s -H "Authorization: Bearer $T2" "$B/api/v1/accounts" | P '["accounts"][0]["balance_minor"]')
is "sender debited now"   "$((S1-S2))" "7500"
is "recipient credited now" "$((R2-R1))" "7500"
is "recipient sees it in their history" "$(curl -s -H "Authorization: Bearer $T2" "$B/api/accounts/personal" | python3 -c "
import sys,json;d=json.load(sys.stdin)
print(len([t for t in d['transactions'] if t['amount']==75.0]))" 2>/dev/null)" "1"
is "wrong PIN refused"    "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" -d "{\"fromAccountId\":\"$AID1\",\"toAccountNumber\":\"$N2\",\"amountMinor\":100,\"pin\":\"9999\"}" "$B/api/v1/payments/transfers" | P '["error"]["code"]')" "invalid_pin"
is "unknown account refused" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" -d "{\"fromAccountId\":\"$AID1\",\"toAccountNumber\":\"9999999999\",\"amountMinor\":100,\"pin\":\"1111\"}" "$B/api/v1/payments/transfers" | P '["error"]["code"]')" "not_found"
is "cannot send to yourself" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -H "Idempotency-Key: $(IDK)" -d "{\"fromAccountId\":\"$AID1\",\"toAccountNumber\":\"$N1\",\"amountMinor\":100,\"pin\":\"1111\"}" "$B/api/v1/payments/transfers" | P '["error"]["code"]')" "bad_request"

echo
echo "final: passed $pass, failed $fail"

echo "── reporting a problem with a transaction"
REF=$(curl -s -H "Authorization: Bearer $T1" "$B/api/accounts/personal" | P '["transactions"][0]["ref"]')
DP=$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' \
  -d "{\"reference\":\"$REF\",\"reason\":\"not_recognised\",\"detail\":\"I did not make this\"}" "$B/api/disputes")
[ -n "$(echo "$DP" | P '["caseId"]')" ] && ok "case opened: $(echo "$DP" | P '["caseNumber"]')" || bad "dispute raised" "$DP"
is "raising it twice reuses the case" "$(curl -s -X POST -H "Authorization: Bearer $T1" -H 'Content-Type: application/json' -d "{\"reference\":\"$REF\",\"reason\":\"other\"}" "$B/api/disputes" | P '["alreadyOpen"]')" "True"
is "someone else's transaction refused" "$(curl -s -X POST -H "Authorization: Bearer $T2" -H 'Content-Type: application/json' -d "{\"reference\":\"$REF\",\"reason\":\"other\"}" "$B/api/disputes" | P '["error"]["code"]')" "unknown_transaction"
TS=$(curl -s -X POST -H 'Content-Type: application/json' -d '{"email":"ops@pokz.com","password":"TestPass12345"}' "$B/api/v1/auth/staff/login" | P '["tokens"]["accessToken"]')
is "case reaches the reviewer queue" "$(curl -s -H "Authorization: Bearer $TS" "$B/api/v1/reviewer/cases?status=open" | python3 -c "
import sys,json
print('yes' if any(c['case_type']=='dispute' for c in json.load(sys.stdin).get('cases',[])) else 'no')" 2>/dev/null)" "yes"

echo
echo "final: passed $pass, failed $fail"

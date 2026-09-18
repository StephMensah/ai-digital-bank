#!/usr/bin/env bash
# Walks every customer-facing function, success and failure, for two separate
# customers — proving the profiles do not bleed into each other.
B="http://localhost:10095"
P() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d$1'))" 2>/dev/null; }
IDK() { echo "idem-$RANDOM$RANDOM$RANDOM"; }
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

M1="+233$(printf %09d $((RANDOM%899999999+100000000)))"
M2="+233$(printf %09d $((RANDOM%899999999+100000000)))"

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
M3="+233$(printf %09d $((RANDOM%899999999+100000000)))"
T3=$(curl -s -X POST -H 'Content-Type: application/json' -d "{\"fullName\":\"Referred Person\",\"msisdn\":\"$M3\",\"email\":\"r$RANDOM@x.com\",\"password\":\"PassThree123\"}" "$B/api/v1/auth/register" | P '["tokens"]["accessToken"]')
K3=$(curl -s -X POST -H "Authorization: Bearer $T3" -H 'Content-Type: application/json' -d '{"idNumber":"GHA-333333333-0","dateOfBirth":"1990-01-01"}' "$B/api/v1/kyc/ghana-card")
is "bad card refers, no account" "$(echo "$K3" | P '["status"]')" "in_review"
is "referred customer has no account" "$(curl -s -H "Authorization: Bearer $T3" "$B/api/v1/accounts" | P '["accounts"].__len__()')" "0"

echo "── session boundaries"
is "no token, no accounts" "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/accounts/personal")" "401"
is "no token, no transfer" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$B/api/transactions")" "401"

echo
echo "passed $pass, failed $fail"

#!/usr/bin/env bash
# Run on your LAPTOP (needs an authenticated gcloud).
# Creates the temporary NanoClaw VM, copies the bootstrap script onto it,
# and opens an SSH session so you can run it.
#
#   bash scripts/cloud-vm/create-vm.sh
#
# Override defaults with env vars, e.g. ZONE=us-central1-a MACHINE_TYPE=e2-standard-2
set -euo pipefail

PROJECT="${PROJECT:-mentors-and-more}"
VM_NAME="${VM_NAME:-mentors-claw}"
ZONE="${ZONE:-us-west2-a}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"   # 4 GB RAM; bump to e2-standard-2 if container builds OOM
DISK_SIZE="${DISK_SIZE:-30GB}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Project:  $PROJECT"
echo "VM:       $VM_NAME ($MACHINE_TYPE, $DISK_SIZE) in $ZONE"
echo

if gcloud compute instances describe "$VM_NAME" --project="$PROJECT" --zone="$ZONE" >/dev/null 2>&1; then
  echo "VM already exists — skipping create."
else
  gcloud compute instances create "$VM_NAME" \
    --project="$PROJECT" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=ubuntu-2404-lts-amd64 \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size="$DISK_SIZE"
  echo "Waiting 30s for sshd to come up..."
  sleep 30
fi

gcloud compute scp "$HERE/bootstrap-vm.sh" "$VM_NAME:~/bootstrap-vm.sh" \
  --project="$PROJECT" --zone="$ZONE"

echo
echo "Copied bootstrap-vm.sh. Opening SSH — once in, run:"
echo "    bash ~/bootstrap-vm.sh"
echo
exec gcloud compute ssh "$VM_NAME" --project="$PROJECT" --zone="$ZONE"

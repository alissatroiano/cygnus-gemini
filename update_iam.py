import subprocess
import json
import sys

project_id = 'cygnus-489217'
cb_sa = '260677658333@cloudbuild.gserviceaccount.com'
roles = ['roles/developerconnect.readOnlyAccess', 'roles/developerconnect.readTokenAccessor']

def run(cmd):
    result = subprocess.run(cmd, capture_output=True, text=True, shell=True)
    if result.returncode != 0:
        print(f"Error running {' '.join(cmd) if isinstance(cmd, list) else cmd}: {result.stderr}")
        return None
    return result.stdout

# 1. Get current policy
print("Getting current policy...")
policy_json = run(f"gcloud projects get-iam-policy {project_id} --format=json")
if not policy_json:
    sys.exit(1)

policy = json.loads(policy_json)

# 2. Add bindings
for role in roles:
    found = False
    for binding in policy.get('bindings', []):
        if binding.get('role') == role and 'condition' not in binding:
            if cb_sa not in binding['members']:
                binding['members'].append(cb_sa)
            found = True
            break
    if not found:
        policy['bindings'].append({
            'members': [cb_sa],
            'role': role
        })

# 3. Write to temp file
with open('iam_policy_auto.json', 'w') as f:
    json.dump(policy, f)

# 4. Set policy
print("Setting updated policy...")
set_result = run(f"gcloud projects set-iam-policy {project_id} iam_policy_auto.json")
if set_result:
    print("Policy updated successfully!")
else:
    print("Failed to update policy.")

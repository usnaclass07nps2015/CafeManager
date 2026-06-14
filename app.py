import sqlite3, os, json, uuid, csv, io, hashlib, socket, urllib.request
from datetime import datetime
from functools import wraps
from flask import Flask, render_template, request, jsonify, Response, session, redirect, url_for

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'cafe-bakery-secret-key-change-me')
DB_PATH = os.path.join(app.root_path, 'cafe.db')

UPLOAD_FOLDER = os.path.join(app.root_path, 'static', 'uploads')
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp'}
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db():
    conn = get_db()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS menu_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('drink','bakery','addon')),
            price REAL NOT NULL,
            description TEXT DEFAULT '',
            image TEXT DEFAULT '',
            available INTEGER DEFAULT 1,
            drink_config TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            items TEXT NOT NULL,
            subtotal REAL NOT NULL,
            discount REAL DEFAULT 0,
            total REAL NOT NULL,
            payment_method TEXT DEFAULT 'cash',
            created_at TEXT NOT NULL,
            order_type TEXT DEFAULT 'here',
            customer_name TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS promotions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            discount_percent REAL NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            active INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS ads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT DEFAULT '',
            image TEXT DEFAULT '',
            media_type TEXT DEFAULT 'image',
            media_url TEXT DEFAULT '',
            active INTEGER DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS toppings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            price REAL NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL
        );
    ''')
    # seed default admin
    existing = conn.execute('SELECT COUNT(*) as c FROM users').fetchone()['c']
    if existing == 0:
        pw = hashlib.sha256('admin123'.encode()).hexdigest()
        conn.execute('INSERT INTO users (username, password_hash) VALUES (?,?)', ('admin', pw))
    # migrate: add drink_config if missing
    try:
        conn.execute('ALTER TABLE menu_items ADD COLUMN drink_config TEXT DEFAULT ""')
    except sqlite3.OperationalError:
        pass
    # migrate: add order_type if missing
    try:
        conn.execute('ALTER TABLE sales ADD COLUMN order_type TEXT DEFAULT "here"')
    except sqlite3.OperationalError:
        pass
    # migrate: update category CHECK to include 'addon'
    try:
        conn.execute("INSERT INTO menu_items (name, category, price) VALUES ('_migrate_check','addon',0)")
        conn.execute("DELETE FROM menu_items WHERE name='_migrate_check'")
    except (sqlite3.OperationalError, sqlite3.IntegrityError):
        # CHECK constraint rejected 'addon' — recreate table
        conn.executescript('''
            CREATE TABLE menu_items_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                price REAL NOT NULL,
                description TEXT DEFAULT '',
                image TEXT DEFAULT '',
                available INTEGER DEFAULT 1,
                drink_config TEXT DEFAULT ''
            );
            INSERT INTO menu_items_new SELECT * FROM menu_items;
            DROP TABLE menu_items;
            ALTER TABLE menu_items_new RENAME TO menu_items;
        ''')
    # migrate: add customer_name if missing
    try:
        conn.execute('ALTER TABLE sales ADD COLUMN customer_name TEXT DEFAULT ""')
    except sqlite3.OperationalError:
        pass
    # migrate: add settings table
    conn.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    ''')
    # migrate: add role column to users
    try:
        conn.execute('ALTER TABLE users ADD COLUMN role TEXT DEFAULT "staff"')
    except sqlite3.OperationalError:
        pass
    # ensure admin has admin role
    conn.execute('UPDATE users SET role="admin" WHERE username="admin"')
    # migrate: add payment_confirmed column
    try:
        conn.execute('ALTER TABLE sales ADD COLUMN payment_confirmed INTEGER DEFAULT 1')
    except sqlite3.OperationalError:
        pass
    # migrate: add daily_seq column
    try:
        conn.execute('ALTER TABLE sales ADD COLUMN daily_seq INTEGER DEFAULT 0')
    except sqlite3.OperationalError:
        pass
    # backfill daily_seq for existing orders
    from collections import defaultdict
    day_seqs = defaultdict(int)
    old_rows = conn.execute("SELECT id, created_at FROM sales WHERE daily_seq=0 ORDER BY created_at").fetchall()
    for r in old_rows:
        day = r['created_at'][:10]
        day_seqs[day] += 1
        conn.execute("UPDATE sales SET daily_seq=? WHERE id=?", (day_seqs[day], r['id']))
    # migrate: add media_type / media_url columns to ads
    try:
        conn.execute('ALTER TABLE ads ADD COLUMN media_type TEXT DEFAULT "image"')
        conn.execute('ALTER TABLE ads ADD COLUMN media_url TEXT DEFAULT ""')
    except sqlite3.OperationalError:
        pass
    conn.commit()
    conn.close()

init_db()

# ─── Auth helpers ─────────────────────────────────────────────────────
def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        if session.get('role') != 'admin':
            return jsonify({'error': 'Admin access required'}), 403
        return f(*args, **kwargs)
    return decorated

def admin_or_manager_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        if session.get('role') not in ('admin', 'manager'):
            return jsonify({'error': 'Admin or manager access required'}), 403
        return f(*args, **kwargs)
    return decorated

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'GET':
        return render_template('login.html')
    data = request.form
    username = data.get('username', '').strip()
    password = data.get('password', '')
    if not username or not password:
        return render_template('login.html', error='Please fill in all fields')
    conn = get_db()
    user = conn.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
    conn.close()
    if user and user['password_hash'] == hashlib.sha256(password.encode()).hexdigest():
        session['user_id'] = user['id']
        session['username'] = user['username']
        session['role'] = user['role']
        return redirect(url_for('index'))
    return render_template('login.html', error='Invalid username or password')

# ─── Password Reset (localhost only) ─────────────────────────────────
@app.route('/api/reset-password', methods=['POST'])
def reset_password():
    if request.remote_addr not in ('127.0.0.1', '::1', 'localhost'):
        return jsonify({'error': 'Localhost only'}), 403
    data = request.json
    username = data.get('username', '').strip()
    password = data.get('password', '')
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    if len(password) < 8 or not any(c.isalpha() for c in password) or not any(c.isdigit() for c in password):
        return jsonify({'error': 'Password must be 8+ chars with letters and numbers'}), 400
    conn = get_db()
    existing = conn.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone()
    if not existing:
        conn.close()
        return jsonify({'error': 'User not found'}), 404
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    conn.execute('UPDATE users SET password_hash=? WHERE username=?', (pw_hash, username))
    conn.commit(); conn.close()
    return jsonify({'ok': True, 'message': f'Password reset for {username}'})

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

# ─── Current User ────────────────────────────────────────────────────
@app.route('/api/me')
@login_required
def current_user():
    return jsonify({'id': session['user_id'], 'username': session['username'], 'role': session.get('role', 'staff')})

# ─── User Management ─────────────────────────────────────────────────
def validate_password(password):
    if len(password) < 8:
        return 'Password must be at least 8 characters'
    if not any(c.isalpha() for c in password):
        return 'Password must contain at least one letter'
    if not any(c.isdigit() for c in password):
        return 'Password must contain at least one number'
    return None

@app.route('/api/users')
@login_required
@admin_required
def get_users():
    conn = get_db()
    users = conn.execute('SELECT id, username, role FROM users ORDER BY id').fetchall()
    conn.close()
    return jsonify([dict(u) for u in users])

@app.route('/api/users', methods=['POST'])
@login_required
@admin_required
def add_user():
    data = request.json
    username = data.get('username', '').strip()
    password = data.get('password', '')
    if not username or not password:
        return jsonify({'error': 'Username and password required'}), 400
    err = validate_password(password)
    if err:
        return jsonify({'error': err}), 400
    role = data.get('role', 'staff')
    if role not in ('admin', 'manager', 'staff'):
        return jsonify({'error': 'Invalid role'}), 400
    conn = get_db()
    existing = conn.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone()
    if existing:
        conn.close()
        return jsonify({'error': 'Username already exists'}), 400
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    conn.execute('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)', (username, pw_hash, role))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})

@app.route('/api/users/<int:user_id>', methods=['PUT'])
@login_required
@admin_required
def update_user(user_id):
    data = request.json
    conn = get_db()
    existing = conn.execute('SELECT id, role FROM users WHERE id=?', (user_id,)).fetchone()
    if not existing:
        conn.close()
        return jsonify({'error': 'User not found'}), 404
    role = data.get('role')
    if role is not None:
        if role not in ('admin', 'manager', 'staff'):
            conn.close()
            return jsonify({'error': 'Invalid role'}), 400
        conn.execute('UPDATE users SET role=? WHERE id=?', (role, user_id))
    password = data.get('password', '')
    if password:
        err = validate_password(password)
        if err:
            conn.close()
            return jsonify({'error': err}), 400
        pw_hash = hashlib.sha256(password.encode()).hexdigest()
        conn.execute('UPDATE users SET password_hash=? WHERE id=?', (pw_hash, user_id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})

@app.route('/api/users/<int:user_id>', methods=['DELETE'])
@login_required
@admin_required
def delete_user(user_id):
    if user_id == session.get('user_id'):
        return jsonify({'error': 'Cannot delete yourself'}), 400
    conn = get_db()
    # prevent deleting last admin
    count = conn.execute('SELECT COUNT(*) as c FROM users').fetchone()['c']
    if count <= 1:
        conn.close()
        return jsonify({'error': 'Cannot delete the last user'}), 400
    conn.execute('DELETE FROM users WHERE id=?', (user_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})

# ─── Home ────────────────────────────────────────────────────────────
@app.route('/manifest.json')
@app.route('/static/manifest.json')
def serve_manifest():
    resp = app.make_response(app.send_static_file('manifest.json'))
    resp.headers['Content-Type'] = 'application/manifest+json; charset=utf-8'
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp

@app.route('/')
@login_required
def index():
    return render_template('base.html', page='dashboard')

# ─── Menu ────────────────────────────────────────────────────────────
@app.route('/menu')
@login_required
def menu_page():
    return render_template('base.html', page='menu')

@app.route('/api/menu')
@login_required
def get_menu():
    conn = get_db()
    items = conn.execute('SELECT * FROM menu_items ORDER BY category, name').fetchall()
    conn.close()
    result = []
    for i in items:
        d = dict(i)
        if d['drink_config']:
            try: d['drink_config'] = json.loads(d['drink_config'])
            except: d['drink_config'] = {}
        else:
            d['drink_config'] = {}
        result.append(d)
    return jsonify(result)

@app.route('/api/menu', methods=['POST'])
@login_required
@admin_required
def add_menu_item():
    data = request.json
    drink_config = json.dumps(data.get('drink_config', {}), ensure_ascii=False)
    conn = get_db()
    conn.execute(
        'INSERT INTO menu_items (name, category, price, description, image, drink_config) VALUES (?,?,?,?,?,?)',
        (data['name'], data['category'], data['price'], data.get('description',''),
         data.get('image',''), drink_config)
    )
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/menu/<int:item_id>', methods=['PUT'])
@login_required
@admin_required
def update_menu_item(item_id):
    data = request.json
    drink_config = json.dumps(data.get('drink_config', {}), ensure_ascii=False)
    conn = get_db()
    conn.execute(
        'UPDATE menu_items SET name=?, category=?, price=?, description=?, image=?, available=?, drink_config=? WHERE id=?',
        (data['name'], data['category'], data['price'], data.get('description',''),
         data.get('image',''), data.get('available',1), drink_config, item_id)
    )
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/menu/<int:item_id>', methods=['DELETE'])
@login_required
@admin_required
def delete_menu_item(item_id):
    conn = get_db()
    conn.execute('DELETE FROM menu_items WHERE id=?', (item_id,))
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/menu/<int:item_id>/availability', methods=['PATCH'])
@login_required
@admin_or_manager_required
def toggle_menu_availability(item_id):
    conn = get_db()
    item = conn.execute('SELECT available FROM menu_items WHERE id=?', (item_id,)).fetchone()
    if not item:
        conn.close()
        return jsonify({'error': 'Item not found'}), 404
    new_val = 0 if item['available'] else 1
    conn.execute('UPDATE menu_items SET available=? WHERE id=?', (new_val, item_id))
    conn.commit(); conn.close()
    return jsonify({'ok': True, 'available': new_val})

@app.route('/api/menu/export')
@login_required
@admin_required
def export_menu_csv():
    conn = get_db()
    items = conn.execute('SELECT * FROM menu_items ORDER BY id').fetchall()
    conn.close()
    output = io.StringIO()
    w = csv.writer(output)
    w.writerow(['id','name','category','price','description','available','drink_config'])
    for i in items:
        w.writerow([i['id'], i['name'], i['category'], i['price'],
                     i['description'], i['available'], i['drink_config']])
    bytes_out = io.BytesIO()
    bytes_out.write('\ufeff'.encode('utf-8'))
    bytes_out.write(output.getvalue().encode('utf-8'))
    return Response(bytes_out.getvalue(), mimetype='text/csv',
                    headers={'Content-Disposition': 'attachment;filename=menu.csv'})

@app.route('/api/menu/import', methods=['POST'])
@login_required
@admin_required
def import_menu_csv():
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    file = request.files['file']
    if not file.filename.endswith('.csv'):
        return jsonify({'error': 'Must be a CSV file'}), 400
    content = file.read().decode('utf-8-sig')
    reader = csv.DictReader(io.StringIO(content))
    conn = get_db()
    existing = {r['name']: r['id'] for r in conn.execute('SELECT id, name FROM menu_items').fetchall()}
    added = 0
    updated = 0
    errors = []
    for row in reader:
        name = row.get('name', '').strip()
        if not name: continue
        try:
            category = row.get('category', 'drink').strip()
            if not category: category = 'drink'
            price = float(row.get('price', 0) or 0)
            description = row.get('description', '') or ''
            image = row.get('image', '') or ''
            available = int(row.get('available', 1) or 1)
            drink_config = row.get('drink_config', '') or ''
            if name in existing:
                conn.execute(
                    'UPDATE menu_items SET category=?, price=?, description=?, image=?, available=?, drink_config=? WHERE id=?',
                    (category, price, description, image, available, drink_config, existing[name])
                )
                updated += 1
            else:
                conn.execute(
                    'INSERT INTO menu_items (name, category, price, description, image, available, drink_config) VALUES (?,?,?,?,?,?,?)',
                    (name, category, price, description, image, available, drink_config)
                )
                added += 1
        except Exception as e:
            errors.append(f"row '{name}': {str(e)}")
    conn.commit(); conn.close()
    if errors:
        print('Import errors:', errors)
    return jsonify({'ok': True, 'added': added, 'updated': updated, 'errors': errors[:5]})

# ─── Image Upload ────────────────────────────────────────────────────
@app.route('/api/upload', methods=['POST'])
@login_required
@admin_required
def upload_image():
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    file = request.files['file']
    if file.filename == '' or not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file type'}), 400
    ext = file.filename.rsplit('.', 1)[1].lower()
    filename = f"{uuid.uuid4().hex}.{ext}"
    file.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
    return jsonify({'url': f'/static/uploads/{filename}'})

# ─── Cashier ──────────────────────────────────────────────────────────
@app.route('/cashier')
@login_required
def cashier_page():
    return render_template('base.html', page='cashier')

@app.route('/api/sales', methods=['POST'])
@login_required
def create_sale():
    data = request.json
    conn = get_db()
    payment_method = data.get('payment_method', 'cash')
    payment_confirmed = 1 if payment_method == 'cash' else 0
    today = datetime.now().strftime('%Y-%m-%d')
    seq = conn.execute("SELECT COALESCE(MAX(daily_seq),0)+1 FROM sales WHERE created_at LIKE ?", (today+'%',)).fetchone()[0]
    cur = conn.execute(
        'INSERT INTO sales (items, subtotal, discount, total, payment_method, payment_confirmed, created_at, order_type, customer_name, daily_seq) VALUES (?,?,?,?,?,?,?,?,?,?)',
        (json.dumps(data['items']), data['subtotal'], data.get('discount',0),
         data['total'], payment_method, payment_confirmed, datetime.now().isoformat(),
         data.get('order_type', 'here'), data.get('customer_name', ''), seq)
    )
    sale_id = cur.lastrowid
    conn.commit(); conn.close()
    return jsonify({'ok': True, 'id': sale_id, 'daily_seq': seq})

@app.route('/api/sales')
@login_required
def get_sales():
    conn = get_db()
    sales = conn.execute('SELECT * FROM sales ORDER BY created_at DESC LIMIT 200').fetchall()
    conn.close()
    return jsonify([dict(s) for s in sales])

@app.route('/api/sales/<int:sale_id>/confirm-payment', methods=['POST'])
@login_required
def confirm_payment(sale_id):
    conn = get_db()
    conn.execute('UPDATE sales SET payment_confirmed=1 WHERE id=?', (sale_id,))
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/sales/<int:sale_id>', methods=['DELETE'])
@login_required
@admin_or_manager_required
def delete_sale(sale_id):
    conn = get_db()
    conn.execute('DELETE FROM sales WHERE id=?', (sale_id,))
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/sales', methods=['DELETE'])
@login_required
@admin_or_manager_required
def delete_all_sales():
    conn = get_db()
    conn.execute('DELETE FROM sales')
    conn.commit(); conn.close()
    return jsonify({'ok': True})

# ─── Promotions ──────────────────────────────────────────────────────
@app.route('/promotions')
@login_required
def promotions_page():
    return render_template('base.html', page='promotions')

@app.route('/api/promotions')
@login_required
def get_promotions():
    conn = get_db()
    rows = conn.execute('SELECT * FROM promotions ORDER BY start_date DESC').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/promotions', methods=['POST'])
@login_required
@admin_or_manager_required
def add_promotion():
    data = request.json
    conn = get_db()
    conn.execute(
        'INSERT INTO promotions (name, description, discount_percent, start_date, end_date) VALUES (?,?,?,?,?)',
        (data['name'], data.get('description',''), data['discount_percent'],
         data['start_date'], data['end_date'])
    )
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/promotions/<int:promo_id>', methods=['PUT'])
@login_required
@admin_or_manager_required
def update_promotion(promo_id):
    data = request.json
    conn = get_db()
    conn.execute(
        'UPDATE promotions SET name=?, description=?, discount_percent=?, start_date=?, end_date=?, active=? WHERE id=?',
        (data['name'], data.get('description',''), data['discount_percent'],
         data['start_date'], data['end_date'], data.get('active',1), promo_id)
    )
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/promotions/<int:promo_id>', methods=['DELETE'])
@login_required
@admin_or_manager_required
def delete_promotion(promo_id):
    conn = get_db()
    conn.execute('DELETE FROM promotions WHERE id=?', (promo_id,))
    conn.commit(); conn.close()
    return jsonify({'ok': True})

# ─── Ads ──────────────────────────────────────────────────────────────
@app.route('/ads')
@login_required
def ads_page():
    return render_template('base.html', page='ads')

@app.route('/api/ads')
@login_required
def get_ads():
    conn = get_db()
    rows = conn.execute('SELECT * FROM ads ORDER BY created_at DESC').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/ads', methods=['POST'])
@login_required
@admin_or_manager_required
def add_ad():
    data = request.json
    conn = get_db()
    conn.execute(
        'INSERT INTO ads (title, content, image, media_type, media_url, created_at) VALUES (?,?,?,?,?,?)',
        (data['title'], data.get('content',''), data.get('image',''), data.get('media_type','image'), data.get('media_url',''), datetime.now().isoformat())
    )
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/ads/<int:ad_id>', methods=['PUT'])
@login_required
@admin_or_manager_required
def update_ad(ad_id):
    data = request.json
    conn = get_db()
    conn.execute(
        'UPDATE ads SET title=?, content=?, image=?, media_type=?, media_url=?, active=? WHERE id=?',
        (data['title'], data.get('content',''), data.get('image',''), data.get('media_type','image'), data.get('media_url',''), data.get('active',1), ad_id)
    )
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/ads/<int:ad_id>', methods=['DELETE'])
@login_required
@admin_or_manager_required
def delete_ad(ad_id):
    conn = get_db()
    conn.execute('DELETE FROM ads WHERE id=?', (ad_id,))
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/ads/active')
@login_required
def get_active_ads():
    conn = get_db()
    rows = conn.execute('SELECT * FROM ads WHERE active=1 ORDER BY created_at DESC').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

# ─── Toppings ─────────────────────────────────────────────────────────
@app.route('/api/toppings')
@login_required
def get_toppings():
    conn = get_db()
    rows = conn.execute('SELECT * FROM toppings ORDER BY id').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/toppings', methods=['POST'])
@login_required
@admin_or_manager_required
def add_topping():
    data = request.json
    conn = get_db()
    conn.execute('INSERT INTO toppings (name, price) VALUES (?,?)',
                 (data['name'], data.get('price', 0)))
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/toppings/<int:tid>', methods=['PUT'])
@login_required
@admin_or_manager_required
def update_topping(tid):
    data = request.json
    conn = get_db()
    conn.execute('UPDATE toppings SET name=?, price=? WHERE id=?',
                 (data['name'], data.get('price', 0), tid))
    conn.commit(); conn.close()
    return jsonify({'ok': True})

@app.route('/api/toppings/<int:tid>', methods=['DELETE'])
@login_required
@admin_or_manager_required
def delete_topping(tid):
    conn = get_db()
    conn.execute('DELETE FROM toppings WHERE id=?', (tid,))
    conn.commit(); conn.close()
    return jsonify({'ok': True})

# ─── Dashboard data ──────────────────────────────────────────────────
def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return '127.0.0.1'

def get_public_url():
    try:
        req = urllib.request.Request('http://127.0.0.1:4040/api/tunnels')
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode())
        for t in data.get('tunnels', []):
            if t.get('config', {}).get('addr', '').endswith(':5000'):
                return t['public_url']
        if data.get('tunnels'):
            return data['tunnels'][0]['public_url']
    except:
        pass
    return None

@app.route('/api/dashboard')
@login_required
def dashboard_data():
    conn = get_db()
    menu_count = conn.execute('SELECT COUNT(*) as c FROM menu_items').fetchone()['c']
    today = datetime.now().strftime('%Y-%m-%d')
    today_sales = conn.execute(
        "SELECT COUNT(*) as c, COALESCE(SUM(total),0) as s FROM sales WHERE created_at LIKE ?", (today+'%',)
    ).fetchone()
    active_promos = conn.execute('SELECT COUNT(*) as c FROM promotions WHERE active=1').fetchone()['c']
    active_ads_count = conn.execute('SELECT COUNT(*) as c FROM ads WHERE active=1').fetchone()['c']
    recent_sales = conn.execute('SELECT * FROM sales ORDER BY created_at DESC LIMIT 5').fetchall()
    local_ip = get_local_ip()
    public_url = get_public_url()
    # Auto-save detected public URL to DB so it persists across page loads
    if public_url:
        conn.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', ('public_url', public_url))
    else:
        conn.execute("DELETE FROM settings WHERE key='public_url'")
    stored_url_row = conn.execute("SELECT value FROM settings WHERE key='public_url'").fetchone()
    stored_public_url = stored_url_row['value'] if stored_url_row else None
    pp_row = conn.execute("SELECT value FROM settings WHERE key='promptpay_id'").fetchone()
    promptpay_id = pp_row['value'] if pp_row else ''
    cust_row = conn.execute("SELECT value FROM settings WHERE key='customer_url'").fetchone()
    customer_url = cust_row['value'] if cust_row else ''
    conn.commit()
    conn.close()
    return jsonify({
        'menu_count': menu_count,
        'today_orders': today_sales['c'],
        'today_revenue': today_sales['s'],
        'active_promotions': active_promos,
        'active_ads': active_ads_count,
        'recent_sales': [dict(s) for s in recent_sales],
        'local_ip': local_ip,
        'public_url': public_url,
        'stored_public_url': stored_public_url,
        'customer_url': customer_url,
        'promptpay_id': promptpay_id
    })

# ─── Settings API ─────────────────────────────────────────────────────
@app.route('/api/settings/<key>', methods=['GET'])
@login_required
def get_setting(key):
    conn = get_db()
    row = conn.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
    conn.close()
    return jsonify({'key': key, 'value': row['value'] if row else ''})

@app.route('/api/settings/<key>', methods=['PUT'])
@login_required
def set_setting(key):
    data = request.json
    value = data.get('value', '')
    conn = get_db()
    conn.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', (key, value))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})

# ─── PromptPay Webhook ──────────────────────────────────────────────
@app.route('/api/webhook/promptpay', methods=['POST'])
def promptpay_webhook():
    """
    Accept payment confirmation callbacks from PromptPay services
    or Android notification forwarders (MacroDroid/Tasker).

    Accepts:
      { "sale_id": 123 }                    — confirm by order ID
      { "amount": 150.00 }                  — confirm by matching amount (most recent pending order)
      { "sale_id": 123, "amount": 150.00 }  — both (ID takes priority, amount validates)
    """
    data = request.json
    if not data:
        return jsonify({'error': 'no data'}), 400

    sale_id = data.get('sale_id') or data.get('order_id')
    conn = get_db()

    if sale_id:
        sale = conn.execute('SELECT * FROM sales WHERE id=?', (sale_id,)).fetchone()
        if not sale:
            conn.close()
            return jsonify({'error': 'order not found'}), 404
        # Optional amount validation
        amount = data.get('amount')
        if amount is not None and abs(sale['total'] - amount) > 0.01:
            conn.close()
            return jsonify({'error': 'amount mismatch', 'expected': sale['total'], 'received': amount}), 400
    else:
        # Try to match by amount — find most recent unconfirmed PromptPay order with that total
        amount = data.get('amount')
        if amount is None:
            conn.close()
            return jsonify({'error': 'provide sale_id or amount'}), 400
        sales = conn.execute(
            'SELECT * FROM sales WHERE payment_method="promptpay" AND payment_confirmed=0 AND ABS(total - ?) < 0.01 ORDER BY created_at DESC LIMIT 1',
            (amount,)
        ).fetchall()
        if not sales:
            conn.close()
            return jsonify({'error': 'no matching pending order found', 'amount': amount}), 404
        sale = sales[0]

    if sale['payment_confirmed']:
        conn.close()
        return jsonify({'ok': True, 'message': 'already confirmed', 'sale_id': sale['id']})

    conn.execute('UPDATE sales SET payment_confirmed=1 WHERE id=?', (sale['id'],))
    conn.commit(); conn.close()
    return jsonify({'ok': True, 'message': 'payment confirmed', 'sale_id': sale['id']})

@app.route('/api/webhook/promptpay/info')
def promptpay_webhook_info():
    return jsonify({
        'endpoint': '/api/webhook/promptpay',
        'method': 'POST',
        'accepts': {
            'sale_id': 'int (optional — confirm by order ID)',
            'amount': 'number (optional — auto-match to nearest pending order by total)'
        },
        'example_sale_id': { 'sale_id': 123 },
        'example_amount': { 'amount': 150.00 },
        'example_both': { 'sale_id': 123, 'amount': 150.00 }
    })

# ─── Public: Customer Menu & Ordering ────────────────────────────────
@app.route('/order')
def customer_menu_page():
    return render_template('customer_menu.html')

@app.route('/api/public/menu')
def public_get_menu():
    conn = get_db()
    items = conn.execute('SELECT * FROM menu_items WHERE available=1 ORDER BY category, name').fetchall()
    conn.close()
    result = []
    for i in items:
        d = dict(i)
        if d['drink_config']:
            try: d['drink_config'] = json.loads(d['drink_config'])
            except: d['drink_config'] = {}
        else:
            d['drink_config'] = {}
        result.append(d)
    return jsonify(result)

@app.route('/api/public/order', methods=['POST'])
def public_place_order():
    data = request.json
    conn = get_db()
    today = datetime.now().strftime('%Y-%m-%d')
    seq = conn.execute("SELECT COALESCE(MAX(daily_seq),0)+1 FROM sales WHERE created_at LIKE ?", (today+'%',)).fetchone()[0]
    cur = conn.execute(
        'INSERT INTO sales (items, subtotal, discount, total, payment_method, created_at, order_type, customer_name, daily_seq) VALUES (?,?,?,?,?,?,?,?,?)',
        (json.dumps(data['items']), data['subtotal'], 0,
         data['total'], 'cash', datetime.now().isoformat(),
         'takeaway', data.get('customer_name', ''), seq)
    )
    conn.commit(); conn.close()
    return jsonify({'ok': True, 'id': cur.lastrowid, 'daily_seq': seq})

@app.route('/api/public/promotions')
def public_get_promotions():
    conn = get_db()
    now = datetime.now().isoformat()
    rows = conn.execute(
        'SELECT * FROM promotions WHERE active=1 AND start_date <= ? AND end_date >= ? ORDER BY start_date DESC',
        (now, now)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/public/ads')
def public_get_ads():
    conn = get_db()
    rows = conn.execute('SELECT * FROM ads WHERE active=1 ORDER BY created_at DESC').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))
